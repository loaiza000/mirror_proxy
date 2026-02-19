import Joi from 'joi';

/**
 * Validation schemas for Control Plane API request bodies.
 * Used via the `validateBody` middleware.
 */

const ruleConditionSchema = Joi.object({
  type: Joi.string().valid('path', 'method', 'header', 'query').required(),
  operator: Joi.string().valid('equals', 'contains', 'regex', 'starts_with', 'ends_with').required(),
  key: Joi.string().when('type', {
    is: Joi.valid('header', 'query'),
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  value: Joi.string().required(),
});

const samplingSchema = Joi.object({
  enabled: Joi.boolean().required(),
  percentage: Joi.number().min(0).max(100).required(),
});

export const createRuleSchema = Joi.object({
  name: Joi.string().trim().min(1).max(255).required(),
  enabled: Joi.boolean().default(true),
  conditions: Joi.array().items(ruleConditionSchema).min(1).required(),
  sampling: samplingSchema.required(),
  targets: Joi.array().items(Joi.string().uri({ scheme: ['http', 'https'] })).min(1).required(),
});

export const updateRuleSchema = Joi.object({
  name: Joi.string().trim().min(1).max(255),
  enabled: Joi.boolean(),
  conditions: Joi.array().items(ruleConditionSchema).min(1),
  sampling: samplingSchema,
  targets: Joi.array().items(Joi.string().uri({ scheme: ['http', 'https'] })).min(1),
}).min(1);

export const addTargetSchema = Joi.object({
  target: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
});

export const killSwitchSchema = Joi.object({
  enabled: Joi.boolean().required(),
});

export const paginationSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0),
  target: Joi.string().uri({ scheme: ['http', 'https'] }).optional(),
});
