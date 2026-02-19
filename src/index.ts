import express from 'express';
import http from 'http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

import { config } from './config';
import { logger, metrics, register } from './observability';
import { database } from './persistence';
import { RulesEngine } from './rules';
import { ShadowDispatcher } from './dispatcher';
import { ResponseComparator } from './comparator';
import { createProxyMiddleware, extractRequestContext, ProxyRequest } from './proxy';
import { createControlPlaneRoutes } from './control-plane';

class MirrorProxyApplication {
  private app: express.Application;
  private server: http.Server | null = null;
  private rulesEngine: RulesEngine;
  private dispatcher: ShadowDispatcher;
  private comparator: ResponseComparator;
  private otelSDK: NodeSDK;

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
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    this.app.use((_req: ProxyRequest, res, next) => {
      res.setHeader('X-Powered-By', 'MirrorProxy');
      next();
    });

    this.app.use((req: ProxyRequest, res, next) => {
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
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        uptime: process.uptime(),
      });
    });

    this.app.get('/metrics', async (_req, res) => {
      try {
        const metricsData = await register.metrics();
        res.set('Content-Type', register.contentType);
        res.end(metricsData);
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to generate metrics');
        res.status(500).json({ error: 'Failed to generate metrics' });
      }
    });

    this.app.use('/api/control', createControlPlaneRoutes(
      this.rulesEngine,
      this.dispatcher,
      this.comparator
    ));

    this.app.use('/api/comparisons', async (req, res) => {
      try {
        const limit = parseInt(req.query['limit'] as string) || 100;
        const offset = parseInt(req.query['offset'] as string) || 0;
        const target = req.query['target'] as string;

        const results = await database.getComparisonResults(limit, offset, target);
        const stats = await database.getComparisonStats(target);

        res.json({
          results,
          stats,
          pagination: {
            limit,
            offset,
            total: results.length,
          },
        });
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to get comparison results');
        res.status(500).json({ error: 'Failed to retrieve comparison results' });
      }
    });

    this.app.use((req: ProxyRequest, _res, next) => {
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

        setImmediate(async () => {
          try {
            const dispatchResults = await this.dispatcher.dispatchToTargets(
              shadowRequest,
              evaluation.applicableTargets
            );

            for (const result of dispatchResults) {
              const primaryResponse = {
                status: 0,
                headers: {},
                body: null,
                duration: 0,
              };

              const comparison = this.comparator.compare(
                req.mirrotap?.requestId || 'unknown',
                result.target,
                primaryResponse,
                result.response
              );

              await database.saveComparisonResult(comparison);
            }
          } catch (error) {
            logger.error({ 
              requestId: req.mirrotap?.requestId,
              error: error instanceof Error ? error.message : 'Unknown error' 
            }, 'Failed to process shadow comparison');
          }
        });
      }

      next();
    });

    this.app.use('/', createProxyMiddleware());
  }

  private setupErrorHandling(): void {
    this.app.use((_req: express.Request, res: express.Response) => {
      res.status(404).json({ error: 'Not found' });
    });

    this.app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error({
        error: err.message,
        stack: err.stack,
        method: req.method,
        path: req.path,
      }, 'Unhandled error');

      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });
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
        logger.info({
          port: config.port,
          primaryUpstream: config.primaryUpstream,
          shadowTimeout: config.shadowTimeout,
          tracingEnabled: config.observability.tracingEnabled,
          metricsPort: config.observability.metricsPort,
        }, 'MirrorProxy started successfully');
      });

      this.setupGracefulShutdown();

    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to start application');
      process.exit(1);
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');

      this.server?.close(async () => {
        logger.info('HTTP server closed');

        try {
          if (config.observability.tracingEnabled) {
            await this.otelSDK.shutdown();
            logger.info('OpenTelemetry shut down');
          }

          await database.close();
          logger.info('Database connections closed');

          logger.info('Application shutdown complete');
          process.exit(0);
        } catch (error) {
          logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Error during shutdown');
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

async function main(): Promise<void> {
  const app = new MirrorProxyApplication();
  await app.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Failed to start application:', error);
    process.exit(1);
  });
}

export { MirrorProxyApplication };
