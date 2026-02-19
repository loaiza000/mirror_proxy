import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  name: 'mirrotap',
  level: config.observability.logLevel,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact sensitive fields that might leak into logs
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'secret'],
    censor: '[REDACTED]',
  },
});

export type Logger = typeof logger;
