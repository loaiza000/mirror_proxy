import { register, Counter, Histogram, Gauge } from 'prom-client';

export { register };

export const metrics = {
  requestsTotal: new Counter({
    name: 'mirrotap_requests_total',
    help: 'Total number of requests processed',
    labelNames: ['method', 'status', 'target'],
    registers: [register],
  }),

  requestDuration: new Histogram({
    name: 'mirrotap_request_duration_seconds',
    help: 'Request duration in seconds',
    labelNames: ['method', 'target', 'type'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [register],
  }),

  shadowRequestsTotal: new Counter({
    name: 'mirrotap_shadow_requests_total',
    help: 'Total number of shadow requests',
    labelNames: ['target', 'status'],
    registers: [register],
  }),

  shadowRequestDuration: new Histogram({
    name: 'mirrotap_shadow_request_duration_seconds',
    help: 'Shadow request duration in seconds',
    labelNames: ['target'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [register],
  }),

  comparisonResults: new Counter({
    name: 'mirrotap_comparison_results_total',
    help: 'Total number of response comparisons',
    labelNames: ['result'],
    registers: [register],
  }),

  activeShadowTargets: new Gauge({
    name: 'mirrotap_active_shadow_targets',
    help: 'Number of active shadow targets',
    registers: [register],
  }),

  killSwitchStatus: new Gauge({
    name: 'mirrotap_kill_switch_enabled',
    help: 'Kill switch status (1 = enabled, 0 = disabled)',
    registers: [register],
  }),
};
