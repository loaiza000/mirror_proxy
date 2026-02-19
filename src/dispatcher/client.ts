import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { logger, metrics, finishSpan, setSpanAttributes } from '../observability';
import { trace, SpanKind } from '@opentelemetry/api';
import { config } from '../config';

const tracer = trace.getTracer('mirrotap-shadow');

export interface ShadowRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: any;
}

export interface ShadowResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
  duration: number;
  error?: string;
}

export class ShadowClient {
  private client: AxiosInstance;
  private target: string;

  constructor(target: string) {
    this.target = target;
    this.client = axios.create({
      baseURL: target,
      timeout: config.shadowTimeout,
      validateStatus: () => true,
    });
  }

  async sendRequest(request: ShadowRequest): Promise<ShadowResponse> {
    const startTime = Date.now();
    const span = tracer.startSpan('shadow.request', {
      kind: SpanKind.CLIENT,
      attributes: { 'shadow.target': this.target },
    });

    try {
      const axiosConfig: AxiosRequestConfig = {
        method: request.method.toLowerCase() as any,
        url: request.path,
        headers: this.filterHeaders(request.headers),
        params: request.query,
        data: request.body,
      };

      setSpanAttributes(span, {
        'shadow.target': this.target,
        'http.method': request.method,
        'http.url': request.path,
      });

      const response: AxiosResponse = await this.client.request(axiosConfig);
      const duration = Date.now() - startTime;

      const shadowResponse: ShadowResponse = {
        status: response.status,
        headers: this.normalizeHeaders(response.headers),
        body: response.data,
        duration,
      };

      metrics.shadowRequestsTotal.inc({
        target: this.target,
        status: response.status.toString(),
      });

      metrics.shadowRequestDuration.observe(
        { target: this.target },
        duration / 1000
      );

      logger.debug(
        {
          target: this.target,
          status: response.status,
          duration,
        },
        'Shadow request completed'
      );

      finishSpan(span);
      return shadowResponse;

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      const shadowResponse: ShadowResponse = {
        status: 0,
        headers: {},
        body: null,
        duration,
        error: errorMessage,
      };

      metrics.shadowRequestsTotal.inc({
        target: this.target,
        status: 'error',
      });

      logger.error(
        {
          target: this.target,
          error: errorMessage,
          duration,
        },
        'Shadow request failed'
      );

      finishSpan(span, error instanceof Error ? error : new Error(errorMessage));
      return shadowResponse;
    }
  }

  private filterHeaders(headers: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {};
    const ignoredHeaders = [
      'host',
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailers',
      'transfer-encoding',
      'upgrade',
    ];

    Object.entries(headers).forEach(([key, value]) => {
      if (!ignoredHeaders.includes(key.toLowerCase()) && !key.startsWith('x-mirrotap')) {
        filtered[key] = value;
      }
    });

    return filtered;
  }

  private normalizeHeaders(headers: any): Record<string, string> {
    const normalized: Record<string, string> = {};
    
    if (typeof headers === 'object' && headers !== null) {
      Object.entries(headers).forEach(([key, value]) => {
        normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      });
    }

    return normalized;
  }

  getTarget(): string {
    return this.target;
  }
}
