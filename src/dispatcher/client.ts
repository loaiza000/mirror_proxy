import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { logger, metrics, finishSpan, setSpanAttributes } from '../observability';
import { trace, SpanKind } from '@opentelemetry/api';
import { config } from '../config';

const tracer = trace.getTracer('mirrotap-shadow');

export interface ShadowRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
}

export interface ShadowResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  duration: number;
  error?: string;
}

/** Headers that must not be forwarded to shadow targets. */
const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

export class ShadowClient {
  private readonly client: AxiosInstance;
  private readonly target: string;

  constructor(target: string) {
    this.target = target;
    this.client = axios.create({
      baseURL: target,
      timeout: config.shadowTimeout,
      validateStatus: () => true,
      // Disable automatic decompression to avoid double-decompressing
      decompress: true,
      maxContentLength: 10 * 1024 * 1024, // 10 MB
      maxBodyLength: 10 * 1024 * 1024,
    });
  }

  async sendRequest(request: ShadowRequest): Promise<ShadowResponse> {
    const startTime = Date.now();
    const span = tracer.startSpan('shadow.request', {
      kind: SpanKind.CLIENT,
      attributes: { 'shadow.target': this.target },
    });

    try {
      const filteredHeaders = this.filterHeaders(request.headers);
      const method = request.method.toLowerCase();

      // Build config inline to avoid exactOptionalPropertyTypes issues with AxiosRequestConfig
      const axiosConfig = {
        method,
        url: request.path,
        headers: filteredHeaders,
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
        headers: this.normalizeHeaders(response.headers as Record<string, string | string[] | undefined>),
        body: response.data as unknown,
        duration,
      };

      metrics.shadowRequestsTotal.inc({
        target: this.target,
        status: response.status.toString(),
      });

      metrics.shadowRequestDuration.observe({ target: this.target }, duration / 1000);

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

    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (!HOP_BY_HOP_HEADERS.has(lower) && !lower.startsWith('x-mirrotap')) {
        filtered[key] = value;
      }
    }

    return filtered;
  }

  private normalizeHeaders(
    headers: Record<string, string | string[] | undefined>
  ): Record<string, string> {
    const normalized: Record<string, string> = {};

    if (typeof headers === 'object' && headers !== null) {
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) {
          normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
        }
      }
    }

    return normalized;
  }

  getTarget(): string {
    return this.target;
  }
}
