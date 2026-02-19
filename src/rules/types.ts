export interface ShadowingRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
  sampling: SamplingConfig;
  targets: string[];
}

export interface RuleCondition {
  type: 'path' | 'method' | 'header' | 'query';
  operator: 'equals' | 'contains' | 'regex' | 'starts_with' | 'ends_with';
  key?: string;
  value: string;
}

export interface SamplingConfig {
  enabled: boolean;
  percentage: number;
}

export interface RequestContext {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: any;
}

export interface RuleEvaluationResult {
  matched: boolean;
  sampled: boolean;
  applicableTargets: string[];
}
