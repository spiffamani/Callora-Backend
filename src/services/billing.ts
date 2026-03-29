/**
 * Billing Service
 *
 * Handles idempotent Soroban-backed billing deductions with:
 * - request_id idempotency
 * - preflight balance checks
 * - transient retry/backoff for deduct calls
 * - usage_events persistence with stellar_tx_hash on success
 */

import type { Pool } from 'pg';

const USDC_7_DECIMAL_FACTOR = 10_000_000n;
const DEFAULT_RETRY_DELAYS_MS = [150, 500, 1_000];

export interface BillingDeductRequest {
  requestId: string;
  userId: string;
  apiId: string;
  endpointId: string;
  apiKeyId: string;
  amountUsdc: string;
  idempotencyKey?: string;
}

export interface BillingDeductResult {
  success: boolean;
  usageEventId: string;
  stellarTxHash?: string;
  alreadyProcessed: boolean;
  error?: string;
}

export interface SorobanBalanceResult {
  balance: string;
}

export interface SorobanDeductResult {
  txHash: string;
}

export interface SorobanClient {
  getBalance(userId: string): Promise<SorobanBalanceResult>;
  deductBalance(
    userId: string,
    amount: string,
    idempotencyKey?: string
  ): Promise<SorobanDeductResult>;
}

export interface BillingServiceOptions {
  retryDelaysMs?: number[];
}

function parseUsdcToContractUnits(amountUsdc: string): bigint {
  const trimmed = amountUsdc.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error('amountUsdc must be a positive decimal with at most 7 fractional digits');
  }

  const [wholePart, fractionalPart = ''] = trimmed.split('.');
  const whole = BigInt(wholePart);
  const fraction = BigInt((fractionalPart + '0000000').slice(0, 7));
  const result = (whole * USDC_7_DECIMAL_FACTOR) + fraction;

  if (result <= 0n) {
    throw new Error('amountUsdc must be greater than zero');
  }

  return result;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

function isTransientSorobanError(error: unknown): boolean {
  const message = normalizeErrorMessage(error).toLowerCase();
  return [
    'timeout',
    'timed out',
    'socket hang up',
    'temporarily unavailable',
    'temporary outage',
    'econnreset',
    'econnrefused',
    '503',
    '429',
    'rate limit',
    'network error',
    'transport error',
  ].some((token) => message.includes(token));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class BillingService {
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly pool: Pool,
    private readonly sorobanClient: SorobanClient,
    options: BillingServiceOptions = {}
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  async deduct(request: BillingDeductRequest): Promise<BillingDeductResult> {
    let amountInContractUnits: bigint;

    try {
      amountInContractUnits = parseUsdcToContractUnits(request.amountUsdc);
    } catch (error) {
      return {
        success: false,
        usageEventId: '',
        alreadyProcessed: false,
        error: normalizeErrorMessage(error),
      };
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const existingEvent = await client.query(
        `SELECT id, stellar_tx_hash
         FROM usage_events
         WHERE request_id = $1`,
        [request.requestId]
      );

      if (existingEvent.rows.length > 0) {
        await client.query('COMMIT');
        return {
          success: true,
          usageEventId: existingEvent.rows[0].id.toString(),
          stellarTxHash: existingEvent.rows[0].stellar_tx_hash ?? undefined,
          alreadyProcessed: true,
        };
      }

      const balanceResult = await this.sorobanClient.getBalance(request.userId);
      const availableBalance = BigInt(balanceResult.balance);

      if (availableBalance < amountInContractUnits) {
        await client.query('ROLLBACK');
        return {
          success: false,
          usageEventId: '',
          alreadyProcessed: false,
          error: `Insufficient balance: required ${amountInContractUnits.toString()} units, available ${availableBalance.toString()}`,
        };
      }

      const insertResult = await client.query(
        `INSERT INTO usage_events
         (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id`,
        [
          request.userId,
          request.apiId,
          request.endpointId,
          request.apiKeyId,
          request.amountUsdc,
          request.requestId,
        ]
      );

      const usageEventId = insertResult.rows[0].id.toString();

      const deductResult = await this.executeDeductWithRetry(
        request.userId,
        amountInContractUnits.toString(),
        request.idempotencyKey ?? request.requestId
      );

      await client.query(
        `UPDATE usage_events
         SET stellar_tx_hash = $1
         WHERE id = $2`,
        [deductResult.txHash, usageEventId]
      );

      await client.query('COMMIT');

      return {
        success: true,
        usageEventId,
        stellarTxHash: deductResult.txHash,
        alreadyProcessed: false,
      };
    } catch (error) {
      await client.query('ROLLBACK');

      if (
        error instanceof Error &&
        'code' in error &&
        error.code === '23505'
      ) {
        const existingEvent = await client.query(
          `SELECT id, stellar_tx_hash
           FROM usage_events
           WHERE request_id = $1`,
          [request.requestId]
        );

        if (existingEvent.rows.length > 0) {
          return {
            success: true,
            usageEventId: existingEvent.rows[0].id.toString(),
            stellarTxHash: existingEvent.rows[0].stellar_tx_hash ?? undefined,
            alreadyProcessed: true,
          };
        }
      }

      return {
        success: false,
        usageEventId: '',
        alreadyProcessed: false,
        error: normalizeErrorMessage(error),
      };
    } finally {
      client.release();
    }
  }

  async getByRequestId(requestId: string): Promise<BillingDeductResult | null> {
    const result = await this.pool.query(
      `SELECT id, stellar_tx_hash
       FROM usage_events
       WHERE request_id = $1`,
      [requestId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      success: true,
      usageEventId: result.rows[0].id.toString(),
      stellarTxHash: result.rows[0].stellar_tx_hash ?? undefined,
      alreadyProcessed: true,
    };
  }

  private async executeDeductWithRetry(
    userId: string,
    amount: string,
    idempotencyKey?: string
  ): Promise<SorobanDeductResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      try {
        return await this.sorobanClient.deductBalance(userId, amount, idempotencyKey);
      } catch (error) {
        lastError = error;

        if (!isTransientSorobanError(error) || attempt === this.retryDelaysMs.length) {
          break;
        }

        await sleep(this.retryDelaysMs[attempt]);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(normalizeErrorMessage(lastError));
  }
}

export const billingInternals = {
  parseUsdcToContractUnits,
  isTransientSorobanError,
};
