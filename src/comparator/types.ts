export interface ResponseData {
  status: number;
  headers: Record<string, string>;
  body: any;
  duration: number;
  error?: string;
}

export interface ComparisonResult {
  requestId: string;
  target: string;
  timestamp: Date;
  primaryResponse: ResponseData;
  shadowResponse: ResponseData;
  differences: Difference[];
  summary: ComparisonSummary;
}

export interface Difference {
  type: 'status' | 'header' | 'body' | 'latency';
  path?: string;
  expected: any;
  actual: any;
  severity: 'critical' | 'major' | 'minor';
}

export interface ComparisonSummary {
  identical: boolean;
  totalDifferences: number;
  criticalDifferences: number;
  majorDifferences: number;
  minorDifferences: number;
  latencyDifference: number;
  latencyDifferencePercent: number;
}

export interface ComparisonConfig {
  ignoreHeaders: string[];
  ignoreBodyFields: string[];
  latencyThresholdPercent: number;
  latencyThresholdMs: number;
  normalizeJsonBody: boolean;
}
