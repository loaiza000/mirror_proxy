import { Router, Request, Response } from 'express';
import { logger } from '../observability';
import { RulesEngine, ShadowingRule } from '../rules';
import { ShadowDispatcher } from '../dispatcher';
import { ResponseComparator } from '../comparator';

export function createControlPlaneRoutes(
  rulesEngine: RulesEngine,
  dispatcher: ShadowDispatcher,
  _comparator: ResponseComparator
): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    });
  });

  router.get('/rules', (_req: Request, res: Response) => {
    try {
      const rules = rulesEngine.getAllRules();
      res.json({ rules });
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to get rules');
      res.status(500).json({ error: 'Failed to retrieve rules' });
    }
  });

  router.post('/rules', (req: Request, res: Response) => {
    try {
      const ruleData = req.body as Omit<ShadowingRule, 'id'>;
      
      if (!ruleData.name || !ruleData.targets || ruleData.targets.length === 0) {
        return res.status(400).json({ 
          error: 'Missing required fields: name, targets' 
        });
      }

      const id = rulesEngine.addRule(ruleData);
      logger.info({ ruleId: id, ruleName: ruleData.name }, 'Rule created via API');
      
      return res.status(201).json({ id, ...ruleData });
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to create rule');
      return res.status(500).json({ error: 'Failed to create rule' });
    }
  });

  router.get('/rules/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: 'Rule ID is required' });
      }
      
      const rule = rulesEngine.getRule(id);
      
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      return res.json(rule);
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to get rule');
      return res.status(500).json({ error: 'Failed to retrieve rule' });
    }
  });

  router.put('/rules/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updates = req.body as Partial<Omit<ShadowingRule, 'id'>>;
      
      if (!id) {
        return res.status(400).json({ error: 'Rule ID is required' });
      }
      
      const success = rulesEngine.updateRule(id, updates);
      
      if (!success) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      const updatedRule = rulesEngine.getRule(id);
      logger.info({ ruleId: id }, 'Rule updated via API');
      
      return res.json(updatedRule);
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to update rule');
      return res.status(500).json({ error: 'Failed to update rule' });
    }
  });

  router.delete('/rules/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      
      if (!id) {
        return res.status(400).json({ error: 'Rule ID is required' });
      }
      
      const success = rulesEngine.removeRule(id);
      
      if (!success) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      logger.info({ ruleId: id }, 'Rule deleted via API');
      return res.status(204).send();
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to delete rule');
      return res.status(500).json({ error: 'Failed to delete rule' });
    }
  });

  router.get('/targets', (_req: Request, res: Response) => {
    try {
      const targets = dispatcher.getTargets();
      res.json({ targets });
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to get targets');
      res.status(500).json({ error: 'Failed to retrieve targets' });
    }
  });

  router.post('/targets', (req: Request, res: Response) => {
    try {
      const { target } = req.body;
      
      if (!target || typeof target !== 'string') {
        return res.status(400).json({ error: 'Target URL is required' });
      }
      
      dispatcher.addTarget(target);
      logger.info({ target }, 'Target added via API');
      
      return res.status(201).json({ target });
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to add target');
      return res.status(500).json({ error: 'Failed to add target' });
    }
  });

  router.delete('/targets/:target', (req: Request, res: Response) => {
    try {
      const { target } = req.params;
      
      if (!target) {
        return res.status(400).json({ error: 'Target is required' });
      }
      
      dispatcher.removeTarget(target);
      logger.info({ target }, 'Target removed via API');
      return res.status(204).send();
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to remove target');
      return res.status(500).json({ error: 'Failed to remove target' });
    }
  });

  router.get('/kill-switch', (_req: Request, res: Response) => {
    try {
      const enabled = rulesEngine.isKillSwitchEnabled();
      res.json({ enabled });
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to get kill switch status');
      res.status(500).json({ error: 'Failed to retrieve kill switch status' });
    }
  });

  router.put('/kill-switch', (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      
      rulesEngine.setKillSwitch(enabled);
      logger.info({ enabled }, 'Kill switch updated via API');
      
      return res.json({ enabled });
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to update kill switch');
      return res.status(500).json({ error: 'Failed to update kill switch' });
    }
  });

  router.get('/status', (_req: Request, res: Response) => {
    try {
      const rules = rulesEngine.getAllRules();
      const targets = dispatcher.getTargets();
      const killSwitchEnabled = rulesEngine.isKillSwitchEnabled();
      
      res.json({
        rules: {
          total: rules.length,
          enabled: rules.filter(r => r.enabled).length,
          disabled: rules.filter(r => !r.enabled).length,
        },
        targets: {
          total: targets.length,
          list: targets,
        },
        killSwitch: {
          enabled: killSwitchEnabled,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to get status');
      res.status(500).json({ error: 'Failed to retrieve status' });
    }
  });

  return router;
}
