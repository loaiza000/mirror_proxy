import { v4 as uuidv4 } from 'uuid';
import { logger } from '../observability';
import { 
  ShadowingRule, 
  RequestContext, 
  RuleEvaluationResult, 
  RuleCondition 
} from './types';

export class RulesEngine {
  private rules: Map<string, ShadowingRule> = new Map();
  private killSwitch: boolean = false;

  addRule(rule: Omit<ShadowingRule, 'id'>): string {
    const id = uuidv4();
    const fullRule: ShadowingRule = { ...rule, id };
    this.rules.set(id, fullRule);
    logger.info({ ruleId: id, ruleName: rule.name }, 'Rule added');
    return id;
  }

  removeRule(id: string): boolean {
    const deleted = this.rules.delete(id);
    if (deleted) {
      logger.info({ ruleId: id }, 'Rule removed');
    }
    return deleted;
  }

  updateRule(id: string, updates: Partial<Omit<ShadowingRule, 'id'>>): boolean {
    const existing = this.rules.get(id);
    if (!existing) {
      return false;
    }

    const updated: ShadowingRule = { ...existing, ...updates };
    this.rules.set(id, updated);
    logger.info({ ruleId: id }, 'Rule updated');
    return true;
  }

  getRule(id: string): ShadowingRule | undefined {
    return this.rules.get(id);
  }

  getAllRules(): ShadowingRule[] {
    return Array.from(this.rules.values());
  }

  setKillSwitch(enabled: boolean): void {
    this.killSwitch = enabled;
    logger.info({ enabled }, 'Kill switch updated');
  }

  isKillSwitchEnabled(): boolean {
    return this.killSwitch;
  }

  evaluateRequest(context: RequestContext): RuleEvaluationResult {
    if (this.killSwitch) {
      return {
        matched: false,
        sampled: false,
        applicableTargets: [],
      };
    }

    const applicableRules = Array.from(this.rules.values())
      .filter(rule => rule.enabled && this.evaluateConditions(rule.conditions, context));

    if (applicableRules.length === 0) {
      return {
        matched: false,
        sampled: false,
        applicableTargets: [],
      };
    }

    const allTargets = applicableRules.flatMap(rule => rule.targets);
    const uniqueTargets = [...new Set(allTargets)];

    const shouldSample = applicableRules.some(rule => 
      !rule.sampling.enabled || this.shouldSample(rule.sampling.percentage)
    );

    return {
      matched: true,
      sampled: shouldSample,
      applicableTargets: uniqueTargets,
    };
  }

  private evaluateConditions(conditions: RuleCondition[], context: RequestContext): boolean {
    return conditions.every(condition => this.evaluateCondition(condition, context));
  }

  private evaluateCondition(condition: RuleCondition, context: RequestContext): boolean {
    let actualValue: string;

    switch (condition.type) {
      case 'path':
        actualValue = context.path;
        break;
      case 'method':
        actualValue = context.method;
        break;
      case 'header':
        actualValue = condition.key ? context.headers[condition.key.toLowerCase()] || '' : '';
        break;
      case 'query':
        actualValue = condition.key ? context.query[condition.key] || '' : '';
        break;
      default:
        return false;
    }

    return this.compareValues(actualValue, condition.operator, condition.value);
  }

  private compareValues(actual: string, operator: string, expected: string): boolean {
    switch (operator) {
      case 'equals':
        return actual === expected;
      case 'contains':
        return actual.includes(expected);
      case 'starts_with':
        return actual.startsWith(expected);
      case 'ends_with':
        return actual.endsWith(expected);
      case 'regex':
        try {
          const regex = new RegExp(expected);
          return regex.test(actual);
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  private shouldSample(percentage: number): boolean {
    if (percentage <= 0) return false;
    if (percentage >= 100) return true;
    
    const random = Math.random() * 100;
    return random <= percentage;
  }
}
