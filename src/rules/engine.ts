import { v4 as uuidv4 } from 'uuid';
import { logger } from '../observability';
import {
  ShadowingRule,
  RequestContext,
  RuleEvaluationResult,
  RuleCondition,
} from './types';

/** Maximum allowed length for a user-supplied regex pattern. */
const MAX_REGEX_LENGTH = 256;

/** Timeout (ms) for regex evaluation to prevent ReDoS. */
const REGEX_EVAL_TIMEOUT_MS = 50;

export class RulesEngine {
  private rules: Map<string, ShadowingRule> = new Map();
  private killSwitch = false;

  // Compiled regex cache to avoid re-compilation on every request
  private regexCache: Map<string, RegExp> = new Map();

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

    // Invalidate regex cache when rules are updated
    this.regexCache.clear();

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

    const applicableRules = Array.from(this.rules.values()).filter(
      (rule) => rule.enabled && this.evaluateConditions(rule.conditions, context)
    );

    if (applicableRules.length === 0) {
      return {
        matched: false,
        sampled: false,
        applicableTargets: [],
      };
    }

    const allTargets = applicableRules.flatMap((rule) => rule.targets);
    const uniqueTargets = [...new Set(allTargets)];

    const shouldSample = applicableRules.some(
      (rule) => !rule.sampling.enabled || this.shouldSample(rule.sampling.percentage)
    );

    return {
      matched: true,
      sampled: shouldSample,
      applicableTargets: uniqueTargets,
    };
  }

  private evaluateConditions(
    conditions: RuleCondition[],
    context: RequestContext
  ): boolean {
    return conditions.every((condition) => this.evaluateCondition(condition, context));
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
        actualValue = condition.key
          ? context.headers[condition.key.toLowerCase()] ?? ''
          : '';
        break;
      case 'query':
        actualValue = condition.key ? context.query[condition.key] ?? '' : '';
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
        return this.safeRegexTest(expected, actual);
      default:
        return false;
    }
  }

  /**
   * Safely evaluates a regex pattern against a value.
   * Guards against ReDoS by limiting pattern length and catching errors.
   */
  private safeRegexTest(pattern: string, value: string): boolean {
    if (pattern.length > MAX_REGEX_LENGTH) {
      logger.warn(
        { patternLength: pattern.length, maxLength: MAX_REGEX_LENGTH },
        'Regex pattern exceeds maximum length, skipping evaluation'
      );
      return false;
    }

    try {
      let regex = this.regexCache.get(pattern);
      if (!regex) {
        regex = new RegExp(pattern);
        this.regexCache.set(pattern, regex);
      }

      // Use Date.now() for basic timeout detection
      const start = Date.now();
      const result = regex.test(value);
      const elapsed = Date.now() - start;

      if (elapsed > REGEX_EVAL_TIMEOUT_MS) {
        logger.warn(
          { pattern, elapsed, threshold: REGEX_EVAL_TIMEOUT_MS },
          'Regex evaluation took too long, consider simplifying the pattern'
        );
      }

      return result;
    } catch {
      logger.warn({ pattern }, 'Invalid regex pattern');
      return false;
    }
  }

  private shouldSample(percentage: number): boolean {
    if (percentage <= 0) return false;
    if (percentage >= 100) return true;

    return Math.random() * 100 < percentage;
  }
}
