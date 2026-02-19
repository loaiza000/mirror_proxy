import dotenv from 'dotenv';
import Joi from 'joi';

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

const envSchema = Joi.object({
  PORT: Joi.number().port().default(3000),
  PRIMARY_UPSTREAM: Joi.string().uri({ scheme: ['http', 'https'] }).default('http://localhost:8080'),
  SHADOW_TIMEOUT: Joi.number().integer().min(100).max(60000).default(5000),
  KILL_SWITCH: Joi.boolean().default(false),

  DB_HOST: Joi.string().hostname().allow('').default(''),
  DB_PORT: Joi.number().port().default(27017),
  DB_NAME: Joi.string().allow('').default(''),
  DB_USER: Joi.string().allow('').default(''),
  DB_PASSWORD: Joi.string().allow('').default(''),

  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent').default('info'),
  METRICS_PORT: Joi.number().port().default(9090),
  TRACING_ENABLED: Joi.boolean().default(true),
}).unknown(true);

const { error, value: envVars } = envSchema.validate(process.env, {
  abortEarly: false,
  stripUnknown: false,
});

if (error) {
  const details = error.details.map((d) => `  - ${d.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`❌ Invalid environment configuration:\n${details}`);
  process.exit(1);
}

export const config: Config = {
  port: envVars.PORT as number,
  primaryUpstream: envVars.PRIMARY_UPSTREAM as string,
  shadowTimeout: envVars.SHADOW_TIMEOUT as number,
  killSwitch: envVars.KILL_SWITCH as boolean,
  database: {
    host: envVars.DB_HOST as string,
    port: envVars.DB_PORT as number,
    name: envVars.DB_NAME as string,
    username: envVars.DB_USER as string,
    password: envVars.DB_PASSWORD as string,
  },
  observability: {
    logLevel: envVars.LOG_LEVEL as string,
    metricsPort: envVars.METRICS_PORT as number,
    tracingEnabled: envVars.TRACING_ENABLED as boolean,
  },
};
