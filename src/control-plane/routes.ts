import { Router, Request, Response } from 'express';
import { logger } from '../observability';
import { RulesEngine, ShadowingRule } from '../rules';
import { ShadowDispatcher } from '../dispatcher';
import { ResponseComparator } from '../comparator';
import { validateBody, rateLimiter, toErrorMessage } from '../middleware';
import {
  createRuleSchema,
  updateRuleSchema,
  addTargetSchema,
  killSwitchSchema,
} from '../config/schemas';

// Rate limit: 60 requests per minute for control-plane operations
const controlPlaneRateLimit = rateLimiter(60_000, 60);

export function createControlPlaneRoutes(
  rulesEngine: RulesEngine,
  dispatcher: ShadowDispatcher,
  _comparator: ResponseComparator
): Router {
  const router = Router();

  // Apply rate limiting to all control-plane routes
  router.use(controlPlaneRateLimit);

  // ─── Health ──────────────────────────────────────────────────────

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    });
  });

  // ─── Rules CRUD ──────────────────────────────────────────────────

  router.get('/rules', (_req: Request, res: Response) => {
    try {
      const rules = rulesEngine.getAllRules();
      res.json({ rules, total: rules.length });
    } catch (error) {
      logger.error({ error: toErrorMessage(error) }, 'Failed to get rules');
      res.status(500).json({ error: 'Failed to retrieve rules' });
    }
  });

  router.post(
    '/rules',
    validateBody(createRuleSchema),
    (req: Request, res: Response) => {
      try {
        const ruleData = req.body as Omit<ShadowingRule, 'id'>;
        const id = rulesEngine.addRule(ruleData);

        logger.info({ ruleId: id, ruleName: ruleData.name }, 'Rule created via API');
        res.status(201).json({ id, ...ruleData });
      } catch (error) {
        logger.error({ error: toErrorMessage(error) }, 'Failed to create rule');
        res.status(500).json({ error: 'Failed to create rule' });
      }
    }
  );

  router.get('/rules/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const rule = rulesEngine.getRule(id ?? '');

      if (!rule) {
        res.status(404).json({ error: 'Rule not found' });
        return;
      }

      res.json(rule);
    } catch (error) {
      logger.error({ error: toErrorMessage(error) }, 'Failed to get rule');
      res.status(500).json({ error: 'Failed to retrieve rule' });
    }
  });

  router.put(
    '/rules/:id',
    validateBody(updateRuleSchema),
    (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const updates = req.body as Partial<Omit<ShadowingRule, 'id'>>;

        const success = rulesEngine.updateRule(id ?? '', updates);

        if (!success) {
          res.status(404).json({ error: 'Rule not found' });
          return;
        }

        const updatedRule = rulesEngine.getRule(id ?? '');
        logger.info({ ruleId: id }, 'Rule updated via API');
        res.json(updatedRule);
      } catch (error) {
        logger.error({ error: toErrorMessage(error) }, 'Failed to update rule');
        res.status(500).json({ error: 'Failed to update rule' });
      }
    }
  );

  router.delete('/rules/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const success = rulesEngine.removeRule(id ?? '');

      if (!success) {
        res.status(404).json({ error: 'Rule not found' });
        return;
      }

      logger.info({ ruleId: id }, 'Rule deleted via API');
      res.status(204).send();
    } catch (error) {
      logger.error({ error: toErrorMessage(error) }, 'Failed to delete rule');
      res.status(500).json({ error: 'Failed to delete rule' });
    }
  });

  // ─── Targets ─────────────────────────────────────────────────────

  router.get('/targets', (_req: Request, res: Response) => {
    try {
      const targets = dispatcher.getTargets();
      res.json({ targets, total: targets.length });
    } catch (error) {
      logger.error({ error: toErrorMessage(error) }, 'Failed to get targets');
      res.status(500).json({ error: 'Failed to retrieve targets' });
    }
  });

  router.post(
    '/targets',
    validateBody(addTargetSchema),
    (req: Request, res: Response) => {
      try {
        const { target } = req.body as { target: string };

        dispatcher.addTarget(target);
        logger.info({ target }, 'Target added via API');
        res.status(201).json({ target });
      } catch (error) {
        logger.error({ error: toErrorMessage(error) }, 'Failed to add target');
        res.status(500).json({ error: 'Failed to add target' });
      }
    }
  );

  router.delete('/targets/:target', (req: Request, res: Response) => {
    try {
      const target = decodeURIComponent(req.params['target'] ?? '');

      if (!target) {
        res.status(400).json({ error: 'Target is required' });
        return;
      }

      dispatcher.removeTarget(target);
      logger.info({ target }, 'Target removed via API');
      res.status(204).send();
    } catch (error) {
      logger.error({ error: toErrorMessage(error) }, 'Failed to remove target');
      res.status(500).json({ error: 'Failed to remove target' });
    }
  });

  // ─── Kill Switch ─────────────────────────────────────────────────

  router.get('/kill-switch', (_req: Request, res: Response) => {
    try {
      const enabled = rulesEngine.isKillSwitchEnabled();
      res.json({ enabled });
    } catch (error) {
      logger.error({ error: toErrorMessage(error) }, 'Failed to get kill switch status');
      res.status(500).json({ error: 'Failed to retrieve kill switch status' });
    }
  });

  router.put(
    '/kill-switch',
    validateBody(killSwitchSchema),
    (req: Request, res: Response) => {
      try {
        const { enabled } = req.body as { enabled: boolean };

        rulesEngine.setKillSwitch(enabled);
        logger.info({ enabled }, 'Kill switch updated via API');
        res.json({ enabled });
      } catch (error) {
        logger.error({ error: toErrorMessage(error) }, 'Failed to update kill switch');
        res.status(500).json({ error: 'Failed to update kill switch' });
      }
    }
  );

  // ─── Status ──────────────────────────────────────────────────────

  router.get('/status', (_req: Request, res: Response) => {
    try {
      const rules = rulesEngine.getAllRules();
      const targets = dispatcher.getTargets();
      const killSwitchEnabled = rulesEngine.isKillSwitchEnabled();

      res.json({
        rules: {
          total: rules.length,
          enabled: rules.filter((r) => r.enabled).length,
          disabled: rules.filter((r) => !r.enabled).length,
        },
        targets: {
          total: targets.length,
          list: targets,
        },
        killSwitch: {
          enabled: killSwitchEnabled,
        },
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error: toErrorMessage(error) }, 'Failed to get status');
      res.status(500).json({ error: 'Failed to retrieve status' });
    }
  });

  return router;
}
