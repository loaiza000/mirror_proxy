export { logger, type Logger } from './logger';
export { metrics, register } from './metrics';
export { 
  createRootSpan, 
  createShadowSpan, 
  finishSpan, 
  setSpanAttributes,
  type TracingContext 
} from './tracing';
