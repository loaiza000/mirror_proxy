import { isEqual, cloneDeep, omit } from 'lodash';
import { logger, metrics } from '../observability';
import { 
  ResponseData, 
  ComparisonResult, 
  Difference, 
  ComparisonSummary, 
  ComparisonConfig 
} from './types';

export class ResponseComparator {
  private config: ComparisonConfig;

  constructor(config: Partial<ComparisonConfig> = {}) {
    this.config = {
      ignoreHeaders: [
        'date',
        'server',
        'x-request-id',
        'x-correlation-id',
        'x-amz-request-id',
        'x-amzn-trace-id',
        'cf-ray',
        'x-cache',
        'age',
        'etag',
        'last-modified',
      ],
      ignoreBodyFields: ['timestamp', 'createdAt', 'updatedAt', 'id', 'uuid'],
      latencyThresholdPercent: 50,
      latencyThresholdMs: 100,
      normalizeJsonBody: true,
      ...config,
    };
  }

  compare(
    requestId: string,
    target: string,
    primaryResponse: ResponseData,
    shadowResponse: ResponseData
  ): ComparisonResult {
    const differences: Difference[] = [];

    differences.push(...this.compareStatus(primaryResponse, shadowResponse));
    differences.push(...this.compareHeaders(primaryResponse, shadowResponse));
    differences.push(...this.compareBody(primaryResponse, shadowResponse));
    differences.push(...this.compareLatency(primaryResponse, shadowResponse));

    const summary = this.generateSummary(differences, primaryResponse, shadowResponse);

    const result: ComparisonResult = {
      requestId,
      target,
      timestamp: new Date(),
      primaryResponse,
      shadowResponse,
      differences,
      summary,
    };

    metrics.comparisonResults.inc({
      result: summary.identical ? 'identical' : 'different',
    });

    logger.debug(
      {
        requestId,
        target,
        identical: summary.identical,
        totalDifferences: summary.totalDifferences,
      },
      'Response comparison completed'
    );

    return result;
  }

  private compareStatus(primary: ResponseData, shadow: ResponseData): Difference[] {
    const differences: Difference[] = [];

    if (primary.status !== shadow.status) {
      differences.push({
        type: 'status',
        expected: primary.status,
        actual: shadow.status,
        severity: this.getStatusSeverity(primary.status, shadow.status),
      });
    }

    return differences;
  }

  private compareHeaders(primary: ResponseData, shadow: ResponseData): Difference[] {
    const differences: Difference[] = [];

    const primaryHeaders = this.filterHeaders(primary.headers);
    const shadowHeaders = this.filterHeaders(shadow.headers);

    const allHeaderNames = new Set([
      ...Object.keys(primaryHeaders),
      ...Object.keys(shadowHeaders),
    ]);

    for (const headerName of allHeaderNames) {
      const primaryValue = primaryHeaders[headerName];
      const shadowValue = shadowHeaders[headerName];

      if (primaryValue !== shadowValue) {
        differences.push({
          type: 'header',
          path: headerName,
          expected: primaryValue,
          actual: shadowValue,
          severity: 'minor',
        });
      }
    }

    return differences;
  }

  private compareBody(primary: ResponseData, shadow: ResponseData): Difference[] {
    const differences: Difference[] = [];

    if (this.config.normalizeJsonBody) {
      const primaryBody = this.normalizeBody(primary.body);
      const shadowBody = this.normalizeBody(shadow.body);

      if (!isEqual(primaryBody, shadowBody)) {
        differences.push(...this.findBodyDifferences(primaryBody, shadowBody));
      }
    } else {
      if (!isEqual(primary.body, shadow.body)) {
        differences.push({
          type: 'body',
          expected: primary.body,
          actual: shadow.body,
          severity: 'major',
        });
      }
    }

    return differences;
  }

  private compareLatency(primary: ResponseData, shadow: ResponseData): Difference[] {
    const differences: Difference[] = [];

    if (primary.duration > 0 && shadow.duration > 0) {
      const diff = shadow.duration - primary.duration;
      const diffPercent = (Math.abs(diff) / primary.duration) * 100;

      if (Math.abs(diff) > this.config.latencyThresholdMs || 
          diffPercent > this.config.latencyThresholdPercent) {
        differences.push({
          type: 'latency',
          expected: primary.duration,
          actual: shadow.duration,
          severity: diffPercent > 100 ? 'critical' : 'major',
        });
      }
    }

    return differences;
  }

  private filterHeaders(headers: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {};
    
    Object.entries(headers).forEach(([name, value]) => {
      const normalizedName = name.toLowerCase();
      if (!this.config.ignoreHeaders.includes(normalizedName)) {
        filtered[normalizedName] = value;
      }
    });

    return filtered;
  }

  private normalizeBody(body: any): any {
    if (!body) return body;

    if (typeof body === 'object' && !Array.isArray(body)) {
      const cloned = cloneDeep(body);
      return omit(cloned, this.config.ignoreBodyFields);
    }

    return body;
  }

  private findBodyDifferences(primary: any, shadow: any, path: string = ''): Difference[] {
    const differences: Difference[] = [];

    if (typeof primary !== typeof shadow) {
      differences.push({
        type: 'body',
        path: path || 'root',
        expected: primary,
        actual: shadow,
        severity: 'major',
      });
      return differences;
    }

    if (typeof primary !== 'object' || primary === null) {
      if (primary !== shadow) {
        differences.push({
          type: 'body',
          path: path || 'root',
          expected: primary,
          actual: shadow,
          severity: 'major',
        });
      }
      return differences;
    }

    const allKeys = new Set([...Object.keys(primary), ...Object.keys(shadow)]);

    for (const key of allKeys) {
      const currentPath = path ? `${path}.${key}` : key;
      const primaryValue = primary[key];
      const shadowValue = shadow[key];

      if (!isEqual(primaryValue, shadowValue)) {
        if (typeof primaryValue === 'object' && primaryValue !== null) {
          differences.push(...this.findBodyDifferences(primaryValue, shadowValue, currentPath));
        } else {
          differences.push({
            type: 'body',
            path: currentPath,
            expected: primaryValue,
            actual: shadowValue,
            severity: 'major',
          });
        }
      }
    }

    return differences;
  }

  private generateSummary(
    differences: Difference[], 
    primary: ResponseData, 
    shadow: ResponseData
  ): ComparisonSummary {
    const criticalDifferences = differences.filter(d => d.severity === 'critical').length;
    const majorDifferences = differences.filter(d => d.severity === 'major').length;
    const minorDifferences = differences.filter(d => d.severity === 'minor').length;

    const latencyDifference = shadow.duration - primary.duration;
    const latencyDifferencePercent = primary.duration > 0 
      ? (Math.abs(latencyDifference) / primary.duration) * 100 
      : 0;

    return {
      identical: differences.length === 0,
      totalDifferences: differences.length,
      criticalDifferences,
      majorDifferences,
      minorDifferences,
      latencyDifference,
      latencyDifferencePercent,
    };
  }

  private getStatusSeverity(primaryStatus: number, shadowStatus: number): 'critical' | 'major' | 'minor' {
    if (primaryStatus < 400 && shadowStatus >= 400) return 'critical';
    if (primaryStatus >= 400 && shadowStatus < 400) return 'critical';
    if (Math.abs(primaryStatus - shadowStatus) >= 100) return 'major';
    return 'minor';
  }
}
