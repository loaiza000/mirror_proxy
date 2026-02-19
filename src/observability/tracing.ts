import { trace, Span, SpanStatusCode, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('mirrotap');

export interface TracingContext {
  requestId: string;
  method: string;
  path: string;
}

export function createRootSpan(context: TracingContext): Span {
  return tracer.startSpan('http.request', {
    kind: SpanKind.SERVER,
    attributes: {
      'http.method': context.method,
      'http.url': context.path,
      'request.id': context.requestId,
    },
  });
}

export function finishSpan(span: Span, error?: Error): void {
  if (error) {
    span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
  } else {
    span.setStatus({
      code: SpanStatusCode.OK,
    });
  }
  span.end();
}

export function setSpanAttributes(
  span: Span,
  attributes: Record<string, string | number | boolean>
): void {
  for (const [key, value] of Object.entries(attributes)) {
    span.setAttribute(key, value);
  }
}
