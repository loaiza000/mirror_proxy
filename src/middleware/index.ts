import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { logger } from '../observability';

/**
 * Extracts a safe error message from an unknown thrown value.
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

/**
 * Express middleware that validates `req.body` against a Joi schema.
 * Returns 400 with structured error details on validation failure.
 */
export function validateBody(schema: Joi.ObjectSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const details = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message,
      }));

      logger.warn({ details, path: req.path }, 'Request body validation failed');
      res.status(400).json({ error: 'Validation failed', details });
      return;
    }

    req.body = value;
    next();
  };
}

/**
 * Express middleware that validates `req.query` against a Joi schema.
 */
export function validateQuery(schema: Joi.ObjectSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.query, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const details = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message,
      }));

      logger.warn({ details, path: req.path }, 'Query parameter validation failed');
      res.status(400).json({ error: 'Validation failed', details });
      return;
    }

    // Override query with validated and coerced values
    req.query = value as Record<string, string>;
    next();
  };
}

/**
 * Sliding-window in-memory rate limiter middleware.
 * @param windowMs Duration of the window in milliseconds.
 * @param maxRequests Maximum requests allowed per window per IP.
 */
export function rateLimiter(windowMs: number, maxRequests: number) {
  const hits = new Map<string, number[]>();

  // Periodic cleanup to prevent unbounded memory growth
  const CLEANUP_INTERVAL_MS = 60_000;
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits.entries()) {
      const filtered = timestamps.filter((t) => now - t < windowMs);
      if (filtered.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, filtered);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // Allow the timer to not block the Node.js process from exiting
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const timestamps = (hits.get(key) ?? []).filter((t) => now - t < windowMs);

    if (timestamps.length >= maxRequests) {
      const retryAfterSec = Math.ceil(windowMs / 1000);
      res.set('Retry-After', retryAfterSec.toString());
      res.status(429).json({
        error: 'Too many requests',
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    next();
  };
}
