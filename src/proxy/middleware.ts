import { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware as httpProxyMiddleware } from 'http-proxy-middleware';
import { v4 as uuidv4 } from 'uuid';
import { logger, metrics, createRootSpan, finishSpan, setSpanAttributes } from '../observability';
import { config } from '../config';
import { RequestContext } from '../rules';

export interface ProxyRequest extends Request {
  mirrotap?: {
    requestId: string;
    startTime: number;
    originalResponse?: Response;
  };
}

export function createProxyMiddleware() {
  const proxy = httpProxyMiddleware({
    target: config.primaryUpstream,
    changeOrigin: true,
    followRedirects: true,
    timeout: 30000,
    onProxyReq: (_proxyReq, req, _res) => {
      const proxyReqExtended = req as ProxyRequest;
      logger.debug(
        { requestId: proxyReqExtended.mirrotap?.requestId },
        'Forwarding request to upstream'
      );
    },
    onProxyRes: (proxyRes, req, _res) => {
      const proxyReqExtended = req as ProxyRequest;
      const duration = Date.now() - (proxyReqExtended.mirrotap?.startTime || 0);
      
      metrics.requestsTotal.inc({
        method: req.method,
        status: (proxyRes.statusCode || 0).toString(),
        target: 'primary',
      });
      
      metrics.requestDuration.observe(
        {
          method: req.method,
          target: 'primary',
          type: 'upstream',
        },
        duration / 1000
      );

      logger.info(
        {
          requestId: proxyReqExtended.mirrotap?.requestId,
          statusCode: proxyRes.statusCode,
          duration,
        },
        'Primary request completed'
      );
    },
    onError: (err, req, res) => {
      const proxyReqExtended = req as ProxyRequest;
      logger.error(
        { 
          requestId: proxyReqExtended.mirrotap?.requestId,
          error: err.message,
        },
        'Proxy error'
      );
      
      metrics.requestsTotal.inc({
        method: req.method,
        status: '500',
        target: 'primary',
      });

      if (!res.headersSent) {
        res.status(502).json({ error: 'Bad Gateway' });
      }
    },
  });

  return (req: ProxyRequest, res: Response, next: NextFunction) => {
    const requestId = generateRequestId();
    const startTime = Date.now();

    req.mirrotap = {
      requestId,
      startTime,
    };

    const span = createRootSpan({
      requestId,
      method: req.method,
      path: req.path,
    });

    setSpanAttributes(span, {
      'http.target': config.primaryUpstream,
      'user.agent': req.headers['user-agent'] || '',
    });

    res.on('finish', () => {
      finishSpan(span);
    });

    proxy(req, res, next);
  };
}

export function extractRequestContext(req: ProxyRequest): RequestContext {
  const headers: Record<string, string> = {};
  
  Object.entries(req.headers).forEach(([key, value]) => {
    if (typeof value === 'string') {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      headers[key.toLowerCase()] = value.join(', ');
    }
  });

  const query: Record<string, string> = {};
  Object.entries(req.query).forEach(([key, value]) => {
    query[key] = Array.isArray(value) ? value.join(',') : String(value || '');
  });

  return {
    method: req.method,
    path: req.path,
    headers,
    query,
    body: req.body,
  };
}

function generateRequestId(): string {
  return uuidv4();
}
