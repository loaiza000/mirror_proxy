import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  port: number;
  primaryUpstream: string;
  shadowTimeout: number;
  killSwitch: boolean;
  database: {
    host: string;
    port: number;
    name: string;
    username: string;
    password: string;
  };
  observability: {
    logLevel: string;
    metricsPort: number;
    tracingEnabled: boolean;
  };
}

export const config: Config = {
  port: parseInt(process.env['PORT'] || '3000'),
  primaryUpstream: process.env['PRIMARY_UPSTREAM'] || 'http://localhost:8080',
  shadowTimeout: parseInt(process.env['SHADOW_TIMEOUT'] || '5000'),
  killSwitch: process.env['KILL_SWITCH'] === 'true',
  database: {
    host: process.env['DB_HOST'] || '',
    port: parseInt(process.env['DB_PORT'] || '27017'),
    name: process.env['DB_NAME'] || '',
    username: process.env['DB_USER'] || '',
    password: process.env['DB_PASSWORD'] || '',
  },
  observability: {
    logLevel: process.env['LOG_LEVEL'] || 'info',
    metricsPort: parseInt(process.env['METRICS_PORT'] || '9090'),
    tracingEnabled: process.env['TRACING_ENABLED'] !== 'false',
  },
};
