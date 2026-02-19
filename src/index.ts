import express from 'express';
import http from 'http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

import { config } from './config';
import { paginationSchema } from './config/schemas';
import { logger, metrics, register } from './observability';
import { database } from './persistence';
import { RulesEngine } from './rules';
import { ShadowDispatcher } from './dispatcher';
import { ResponseComparator } from './comparator';
import { createProxyMiddleware, extractRequestContext, ProxyRequest } from './proxy';
import { createControlPlaneRoutes } from './control-plane';
import { toErrorMessage, validateQuery, rateLimiter } from './middleware';

/** Graceful shutdown timeout in milliseconds. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

class MirrorProxyApplication {
  private readonly app: express.Application;
  private server: http.Server | null = null;
  private readonly rulesEngine: RulesEngine;
  private readonly dispatcher: ShadowDispatcher;
  private readonly comparator: ResponseComparator;
  private readonly otelSDK: NodeSDK;
  private isShuttingDown = false;

  constructor() {
    this.app = express();
    this.rulesEngine = new RulesEngine();
    this.dispatcher = new ShadowDispatcher();
    this.comparator = new ResponseComparator();
    this.otelSDK = this.initializeOpenTelemetry();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  private initializeOpenTelemetry(): NodeSDK {
    if (!config.observability.tracingEnabled) {
      return new NodeSDK();
    }

    const prometheusExporter = new PrometheusExporter({
      port: config.observability.metricsPort,
    });

    return new NodeSDK({
      instrumentations: [getNodeAutoInstrumentations()],
      metricReader: prometheusExporter,
    });
  }

  private setupMiddleware(): void {
    // Disable Express fingerprinting
    this.app.disable('x-powered-by');

    // Body parsers with size limits
    this.app.use(express.json({ limit: '2mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '2mb' }));

    // Custom identifier header
    this.app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
      res.setHeader('X-Powered-By', 'MirrorProxy');
      next();
    });

    // Metrics collection middleware
    this.app.use((req: ProxyRequest, res: express.Response, next: express.NextFunction) => {
      const startTime = Date.now();

      res.on('finish', () => {
        const duration = Date.now() - startTime;
        metrics.requestsTotal.inc({
          method: req.method,
          status: res.statusCode.toString(),
          target: 'proxy',
        });

        metrics.requestDuration.observe(
          {
            method: req.method,
            target: 'proxy',
            type: 'total',
          },
          duration / 1000
        );
      });

      next();
    });
  }

  private setupRoutes(): void {
    // ─── Health ────────────────────────────────────────────────────
    this.app.get('/health', (_req, res) => {
      res.json({
        status: this.isShuttingDown ? 'shutting_down' : 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        uptime: process.uptime(),
      });
    });

    // ─── Prometheus Metrics ───────────────────────────────────────
    this.app.get('/metrics', async (_req, res) => {
      try {
        const metricsData = await register.metrics();
        res.set('Content-Type', register.contentType);
        res.end(metricsData);
      } catch (error) {
        logger.error({ error: toErrorMessage(error) }, 'Failed to generate metrics');
        res.status(500).json({ error: 'Failed to generate metrics' });
      }
    });

    // ─── Control Plane API ────────────────────────────────────────
    this.app.use(
      '/api/control',
      createControlPlaneRoutes(this.rulesEngine, this.dispatcher, this.comparator)
    );

    // ─── Comparison Results ───────────────────────────────────────
    const comparisonsLimiter = rateLimiter(60_000, 120);

    this.app.get(
      '/api/comparisons',
      comparisonsLimiter,
      validateQuery(paginationSchema),
      async (req: express.Request, res: express.Response) => {
        try {
          const limit = Number(req.query['limit']) || 100;
          const offset = Number(req.query['offset']) || 0;
          const target = req.query['target'] as string | undefined;

          const [results, total, stats] = await Promise.all([
            database.getComparisonResults(limit, offset, target),
            database.getComparisonCount(target),
            database.getComparisonStats(target),
          ]);

          res.json({
            results,
            stats,
            pagination: {
              limit,
              offset,
              total,
            },
          });
        } catch (error) {
          logger.error(
            { error: toErrorMessage(error) },
            'Failed to get comparison results'
          );
          res.status(500).json({ error: 'Failed to retrieve comparison results' });
        }
      }
    );

    // ─── Shadow Dispatch ──────────────────────────────────────────
    this.app.use((req: ProxyRequest, _res: express.Response, next: express.NextFunction) => {
      const context = extractRequestContext(req);
      const evaluation = this.rulesEngine.evaluateRequest(context);

      if (evaluation.matched && evaluation.sampled && evaluation.applicableTargets.length > 0) {
        const shadowRequest = {
          method: req.method,
          path: req.path,
          headers: req.headers as Record<string, string>,
          query: req.query as Record<string, string>,
          body: req.body,
        };

        const requestId = req.mirrotap?.requestId ?? 'unknown';

        // Fire-and-forget shadow processing — errors must not escape
        this.processShadowRequests(requestId, shadowRequest, evaluation.applicableTargets);
      }

      next();
    });

    // ─── Primary Proxy ────────────────────────────────────────────
    this.app.use('/', createProxyMiddleware());
  }

  /**
   * Dispatches shadow requests and saves comparisons.
   * Fully contained — errors are logged but never rethrown.
   */
  private processShadowRequests(
    requestId: string,
    shadowRequest: { method: string; path: string; headers: Record<string, string>; query: Record<string, string>; body: unknown },
    targets: string[]
  ): void {
    setImmediate(() => {
      this.dispatcher
        .dispatchToTargets(shadowRequest, targets)
        .then(async (dispatchResults) => {
          const savePromises = dispatchResults.map((result) => {
            const primaryResponse = {
              status: 0,
              headers: {},
              body: null,
              duration: 0,
            };

            const comparison = this.comparator.compare(
              requestId,
              result.target,
              primaryResponse,
              result.response
            );

            return database.saveComparisonResult(comparison);
          });

          await Promise.allSettled(savePromises);
        })
        .catch((error: unknown) => {
          logger.error(
            {
              requestId,
              error: toErrorMessage(error),
            },
            'Failed to process shadow comparison'
          );
        });
    });
  }

  private setupErrorHandling(): void {
    // 404 handler
    this.app.use((_req: express.Request, res: express.Response) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Global error handler
    this.app.use(
      (err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
        logger.error(
          {
            error: err.message,
            stack: err.stack,
            method: req.method,
            path: req.path,
          },
          'Unhandled error'
        );

        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    );
  }

  async start(): Promise<void> {
    try {
      if (config.observability.tracingEnabled) {
        this.otelSDK.start();
        logger.info('OpenTelemetry initialized');
      }

      await database.initialize();
      logger.info('Database initialized');

      if (config.killSwitch) {
        this.rulesEngine.setKillSwitch(true);
        logger.info('Kill switch enabled from configuration');
      }

      this.server = this.app.listen(config.port, () => {
        logger.info(
          {
            port: config.port,
            primaryUpstream: config.primaryUpstream,
            shadowTimeout: config.shadowTimeout,
            tracingEnabled: config.observability.tracingEnabled,
            metricsPort: config.observability.metricsPort,
          },
          'MirrorProxy started successfully'
        );
      });

      this.setupGracefulShutdown();
    } catch (error) {
      logger.error(
        { error: toErrorMessage(error) },
        'Failed to start application'
      );
      process.exit(1);
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string): Promise<void> => {
      if (this.isShuttingDown) {
        logger.warn({ signal }, 'Duplicate shutdown signal received, ignoring');
        return;
      }

      this.isShuttingDown = true;
      logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

      // Force-exit after timeout to prevent hanging
      const forceExitTimer = setTimeout(() => {
        logger.error('Graceful shutdown timed out, forcing exit');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExitTimer.unref();

      try {
        // Stop accepting new connections
        if (this.server) {
          await new Promise<void>((resolve, reject) => {
            this.server?.close((err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          logger.info('HTTP server closed');
        }

        // Shutdown OpenTelemetry
        if (config.observability.tracingEnabled) {
          await this.otelSDK.shutdown();
          logger.info('OpenTelemetry shut down');
        }

        // Close database connection
        await database.close();
        logger.info('Database connections closed');

        logger.info('Application shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error({ error: toErrorMessage(error) }, 'Error during shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    // Catch uncaught exceptions and unhandled rejections at the process level
    process.on('uncaughtException', (error) => {
      logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
      void shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
      logger.fatal(
        { error: reason instanceof Error ? reason.message : String(reason) },
        'Unhandled promise rejection'
      );
      void shutdown('unhandledRejection');
    });
  }
}

async function main(): Promise<void> {
  const app = new MirrorProxyApplication();
  await app.start();
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start application:', error);
    process.exit(1);
  });
}

export { MirrorProxyApplication };
