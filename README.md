# MirrorProxy

Production-grade traffic shadowing and replay system for Node.js applications.

## Overview

MirrorProxy receives incoming HTTP traffic, forwards it to the real upstream service, and asynchronously duplicates the request to one or more shadow services without impacting user-facing latency. It then compares responses between the real service and shadow services to detect behavioral differences before real deployments.

## Features

- **HTTP Proxy Middleware**: Forwards requests to primary upstream service
- **Asynchronous Shadow Dispatch**: Duplicates requests to shadow targets with strict timeouts
- **Response Comparison Engine**: Compares status codes, normalized response bodies, and latency
- **Rules Engine**: Route-based filtering, HTTP method filtering, and percentage-based sampling
- **Global Kill Switch**: Immediately disables all shadow traffic
- **Control Plane API**: CRUD operations for shadow targets and rules management
- **Persistence**: Stores comparison results in MongoDB
- **Observability**: Structured logging, metrics, and distributed tracing with OpenTelemetry

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Client        │───▶│   MirrorProxy    │───▶│ Primary Service │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌─────────────────┐
                       │ Shadow Service  │
                       │ Shadow Service  │
                       │ Shadow Service  │
                       └─────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+ 
- MongoDB 4.4+
- TypeScript 5+

### Installation

```bash
# Clone the repository
git clone https://github.com/loaiza000/mirror_proxy
cd mirror_proxy

# Install dependencies
npm install

# Build the application
npm run build

# Start the application
npm start
```

### Development

```bash
# Run in development mode
npm run dev

# Run tests
npm test

# Lint code
npm run lint

# Format code
npm run format
```

## API Endpoints

### Health Check
```
GET /health
```

### Control Plane API

#### Rules Management
```
GET    /api/control/rules          # List all rules
POST   /api/control/rules          # Create new rule
GET    /api/control/rules/:id      # Get specific rule
PUT    /api/control/rules/:id      # Update rule
DELETE /api/control/rules/:id      # Delete rule
```

#### Shadow Targets
```
GET    /api/control/targets        # List all targets
POST   /api/control/targets        # Add new target
DELETE /api/control/targets/:url   # Remove target
```

#### Kill Switch
```
GET    /api/control/kill-switch    # Get kill switch status
PUT    /api/control/kill-switch    # Toggle kill switch
```

#### System Status
```
GET    /api/control/status         # Get system status
```

### Comparison Results
```
GET /api/comparisons              # Get comparison results with pagination
```

### Metrics
```
GET /metrics                       # Prometheus metrics endpoint
```

## Rule Configuration

Rules define when and how traffic should be shadowed:

```json
{
  "name": "API Shadowing",
  "enabled": true,
  "conditions": [
    {
      "type": "path",
      "operator": "starts_with",
      "value": "/api/v1"
    },
    {
      "type": "method",
      "operator": "equals",
      "value": "GET"
    }
  ],
  "sampling": {
    "enabled": true,
    "percentage": 10
  },
  "targets": [
    "http://shadow-service-1:8080",
    "http://shadow-service-2:8080"
  ]
}
```

## Response Comparison

The comparison engine analyzes:

- **Status Codes**: Critical differences in HTTP status codes
- **Headers**: Ignores non-deterministic headers (date, server, request IDs)
- **Body**: Normalizes JSON by removing timestamps, IDs, and other dynamic fields
- **Latency**: Detects significant performance differences

## Database Schema

Comparison results are stored in MongoDB using Mongoose ODM with the following structure:

```javascript
{
  requestId: String,
  target: String,
  timestamp: Date,
  primaryResponse: Object,
  shadowResponse: Object,
  differences: Array,
  summary: Object
}
```

## Observability

### Logging
Structured JSON logging with Pino at configurable levels.

### Metrics
Prometheus metrics for:
- Request counts and durations
- Shadow request statistics
- Comparison results
- Active targets and kill switch status

### Tracing
OpenTelemetry distributed tracing for request flow visualization.

## Production Deployment

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### Kubernetes

Deploy with proper resource limits, health checks, and configuration management.

### Monitoring

Monitor key metrics:
- Shadow request success rates
- Comparison result patterns
- Latency differences
- Error rates

## Security Considerations

- Shadow requests never impact production traffic
- Configurable timeouts prevent resource exhaustion
- Kill switch provides immediate emergency stop
- Request filtering prevents sensitive data exposure


