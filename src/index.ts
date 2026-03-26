import express from 'express';
import { initializeDb, closeDb } from './db/index.js';
import { closePgPool } from './db.js';
import { closeDbPool } from './config/health.js';
import { disconnectPrisma } from './lib/prisma.js';
import { errorHandler } from './middleware/errorHandler.js';
import type { Socket } from 'net';
import type { Server } from 'http';

import { createDeveloperRouter } from './routes/developerRoutes.js';
import { createGatewayRouter } from './routes/gatewayRoutes.js';
import { createProxyRouter } from './routes/proxyRoutes.js';
import { createBillingService } from './services/billingService.js';
import { createRateLimiter } from './services/rateLimiter.js';
import { createUsageStore } from './services/usageStore.js';
import { createSettlementStore } from './services/settlementStore.js';
import { createApiRegistry } from './data/apiRegistry.js';
import { ApiKey } from './types/gateway.js';

type ShutdownLogger = Pick<typeof console, 'log' | 'warn' | 'error'>;

interface GracefulShutdownOptions {
  server: Server;
  activeConnections: Set<Socket>;
  closeDatabase: () => Promise<void>;
  logger?: ShutdownLogger;
  timeoutMs?: number;
}

export function createGracefulShutdownHandler({
  server,
  activeConnections,
  closeDatabase,
  logger = console,
  timeoutMs = 30_000,
}: GracefulShutdownOptions) {
  let shutdownPromise: Promise<number> | null = null;

  return async (signal: NodeJS.Signals | string): Promise<number> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      logger.log(`\n[shutdown] Received ${signal}. Starting graceful shutdown...`);

      const timeoutHandle = setTimeout(() => {
        if (activeConnections.size > 0) {
          logger.warn(`[shutdown] Timeout reached. Destroying ${activeConnections.size} connection(s).`);
          for (const socket of activeConnections) {
            socket.destroy();
          }
        }
      }, timeoutMs);
      timeoutHandle.unref();

      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err?: Error) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
        logger.log('[shutdown] HTTP server closed. No new requests accepted.');

        await closeDatabase();
        logger.log('[shutdown] Database and pools closed.');

        logger.log('[shutdown] Shutdown complete.');
        return 0;
      } catch (error) {
        logger.error('[shutdown] Shutdown failed:', error);
        return 1;
      } finally {
        clearTimeout(timeoutHandle);
      }
    })();

    return shutdownPromise;
  };
}

// Helper for Jest/CommonJS compat
const isDirectExecution = process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

export const app = express();

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'callora-backend' });
});

// Check if fil is being run directly (CommonJS / ESM compatibility trick for ts-jest)

if (isDirectExecution) {

  // Shared services
  const MOCK_DEVELOPER_BALANCES: Record<string, number> = {
    dev_001: 50.0,
    dev_002: 120.5,
  };

  const billing = createBillingService(MOCK_DEVELOPER_BALANCES);
  const rateLimiter = createRateLimiter(5, 60_000); // 5 reqs per minute
  const usageStore = createUsageStore();
  const settlementStore = createSettlementStore();
  const registry = createApiRegistry();

  const apiKeys = new Map<string, ApiKey>([
    ['test-key-1', { key: 'test-key-1', developerId: 'dev_001', apiId: 'api_001' }],
    ['test-key-2', { key: 'test-key-2', developerId: 'dev_002', apiId: 'api_002' }],
  ]);

  // 1. Developer Dashboard Routes (Auth required)
  const developerRouter = createDeveloperRouter({
    settlementStore,
    usageStore,
  });
  app.use('/api/developers', developerRouter);

  // Legacy gateway route (existing)
  const gatewayRouter = createGatewayRouter({
    billing,
    rateLimiter,
    usageStore,
    upstreamUrl: process.env.UPSTREAM_URL ?? 'http://localhost:4000',
    apiKeys,
  });
  app.use('/api/gateway', gatewayRouter);

  // New proxy route: /v1/call/:apiSlugOrId/*
  const proxyRouter = createProxyRouter({
    billing,
    rateLimiter,
    usageStore,
    registry,
    apiKeys,
    proxyConfig: {
      timeoutMs: parseInt(process.env.PROXY_TIMEOUT_MS ?? '30000', 10),
    },
  });
  app.use('/v1/call', proxyRouter);


  app.use(express.json());

  // Global error handler (must be after all routes)
  app.use(errorHandler);

  const PORT = process.env.PORT ?? 3000;

  const closeAllDataResources = async () => {
    await closeDb();
    await Promise.allSettled([
      closePgPool(),
      disconnectPrisma(),
      closeDbPool(),
    ]);
  };

  // Initialize database and start server
  async function startServer() {
    try {
      await initializeDb();
      
      const server = app.listen(PORT, () => {
        console.log(`Callora backend listening on http://localhost:${PORT}`);
      });

      // Track active connections so we can wait for them to finish
      const activeConnections = new Set<Socket>();

      server.on('connection', (socket: Socket) => {
        activeConnections.add(socket);
        socket.once('close', () => activeConnections.delete(socket));
      });

      const gracefulShutdown = createGracefulShutdownHandler({
        server,
        activeConnections,
        closeDatabase: closeAllDataResources,
      });

      const onSignal = (signal: NodeJS.Signals) => {
        void gracefulShutdown(signal).then((exitCode) => {
          process.exit(exitCode);
        });
      };

      // Register shutdown signals
      process.once('SIGTERM', () => onSignal('SIGTERM'));
      process.once('SIGINT', () => onSignal('SIGINT'));

    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  startServer();
}

export default app;