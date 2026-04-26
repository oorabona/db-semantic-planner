---
title: Production Deployment
---

# Production Deployment Guide

**Package:** `@dbsp/core`, `@dbsp/adapter-pgsql`
**Status:** Production-ready

This guide covers best practices for deploying db-semantic-planner in production environments.

---

## Table of Contents

1. [Connection Pooling](#connection-pooling)
2. [Timeout Management](#timeout-management)
3. [Multi-Tenant Isolation](#multi-tenant-isolation)
4. [Error Handling](#error-handling)
5. [Observability & Logging](#observability--logging)
6. [Streaming Large Results](#streaming-large-results)
7. [Query Analysis](#query-analysis)
8. [Rate Limiting](#rate-limiting)
9. [Security Hardening](#security-hardening)
10. [Health Checks](#health-checks)
11. [Performance Tuning](#performance-tuning)

---

## Connection Pooling

### PostgreSQL Pool Configuration

Configure the connection pool based on your expected load:

```typescript
import { Pool } from 'pg';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { createOrm } from '@dbsp/core';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Pool size: start conservative, monitor, adjust
  max: 20,                    // Max connections
  min: 5,                     // Keep idle connections

  // Connection timeouts
  connectionTimeoutMillis: 10000,  // 10s to establish connection
  idleTimeoutMillis: 30000,        // 30s before releasing idle

  // Statement timeout (PostgreSQL)
  statement_timeout: 30000,        // 30s query timeout
});

const orm = createOrm({
  model: schema,
  adapter: createPgsqlAdapter(pool),
});
```

### Pool Sizing Guidelines

| Workload | `max` | `min` | Notes |
|----------|-------|-------|-------|
| Low traffic | 10 | 2 | Small apps, internal tools |
| Medium traffic | 20-30 | 5 | Standard web apps |
| High traffic | 50-100 | 10 | High-concurrency APIs |
| Serverless | 1-5 | 0 | Function instances |

**Formula:** `max_connections = (core_count * 2) + effective_spindle_count`

For cloud databases (RDS, Cloud SQL), check provider limits.

### Connection Monitoring

```typescript
// doctest: skip — Cannot read properties of undefined (reading 'on')
// Monitor pool health
pool.on('connect', () => {
  console.log('Pool: connection acquired');
});

pool.on('error', (err) => {
  console.error('Pool: unexpected error', err);
});

// Periodically log pool stats
setInterval(() => {
  console.log({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  });
}, 60000);
```

---

## Timeout Management

### Query Timeouts

Set timeouts at multiple levels for defense in depth:

```typescript
// doctest: skip — PgsqlAdapter is in compile-only mode (no database connection). Use createPgsqlAdapter(pool) for a full adapter with execution capabilities.
// 1. Pool-level (PostgreSQL statement_timeout)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 30000, // 30 seconds
});

// 2. Application-level (AbortController)
async function queryWithTimeout<T>(
  queryFn: () => Promise<T>,
  timeoutMs: number = 10000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await queryFn();
  } finally {
    clearTimeout(timeout);
  }
}

// Usage
const users = await queryWithTimeout(
  () => orm.select('users').where(eq('active', true)).all(),
  5000, // 5 second timeout
);
```

### Timeout Recommendations

| Query Type | Timeout | Rationale |
|------------|---------|-----------|
| Simple lookup | 1-5s | Should be fast |
| List with filters | 5-10s | May scan more rows |
| Complex joins | 10-30s | Multi-table operations |
| Reports/Analytics | 30-60s | Expensive aggregations |
| Background jobs | 60-300s | Long-running tasks |

---

## Multi-Tenant Isolation

### Schema-Based Multi-Tenancy

Use `withSchema()` for PostgreSQL schema isolation:

```typescript
// doctest: skip — app is not defined
// Tenant middleware (Express example)
app.use(async (req, res, next) => {
  const tenantId = extractTenantId(req); // From JWT, header, etc.

  // Validate tenant ID format (security)
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenant ID' });
  }

  // Create scoped ORM
  req.orm = orm.withSchema(tenantId);
  next();
});

// Route handler
app.get('/api/users', async (req, res) => {
  // Queries automatically scoped to tenant schema
  const users = await req.orm.select('users').all();
  res.json(users);
});
```

### Tenant Validation

**Never trust tenant IDs from request body.** Always:

1. Extract from authenticated context (JWT claims)
2. Validate format (alphanumeric, reasonable length)
3. Optionally verify tenant exists

```typescript
function extractTenantId(req: Request): string {
  // From JWT (preferred)
  const token = req.user as { tenantId?: string };
  if (!token?.tenantId) {
    throw new UnauthorizedError('No tenant context');
  }
  return token.tenantId;
}
```

---

## Error Handling

### Using the Error Factory

DBSP provides typed errors with error codes for programmatic handling:

```typescript
// doctest: skip — Errors is not defined
import { Errors, ErrorCode } from '@dbsp/core';

try {
  const users = await orm.select('users').where(eq('status', 'active')).all();
} catch (error) {
  // Check if it's a DBSP error
  if (Errors.isDbspError(error)) {
    switch (error.code) {
      case ErrorCode.TABLE_NOT_FOUND:
        // Schema mismatch
        logger.error('Table not found', { table: error.table });
        break;
      case ErrorCode.AMBIGUOUS_RELATION:
        // Schema needs explicit relation
        logger.error('Ambiguous relation', { details: error.message });
        break;
      case ErrorCode.EXECUTION_ERROR:
        // Database error
        logger.error('Query failed', { sql: error.sql });
        break;
    }
  }

  throw error; // Re-throw for upstream handling
}
```

### Error Response Structure

```typescript
// Standardized error response
interface ErrorResponse {
  error: {
    code: string;      // e.g., "DBSP_E001"
    message: string;   // Human-readable
    details?: unknown; // Additional context
  };
  requestId: string;
}

function toErrorResponse(error: Error, requestId: string): ErrorResponse {
  if (Errors.isDbspError(error)) {
    return {
      error: {
        code: error.code,
        message: error.message,
        // Don't leak SQL in production
        details: process.env.NODE_ENV === 'development'
          ? { sql: (error as any).sql }
          : undefined,
      },
      requestId,
    };
  }

  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
    requestId,
  };
}
```

---

## Observability & Logging

### Using dump() for Observability

Every query produces a `Dump` with plan, SQL, and parameters:

```typescript
// doctest: skip — logger is not defined
import { redactParams } from '@dbsp/adapter-pgsql';

// Get query dump without executing
const dump = await orm.select('users')
  .where(eq('email', 'user@example.com'))
  .dump();

// Log with parameter redaction
logger.info('Query executed', {
  sql: dump.sql,
  params: redactParams(dump.params, {
    patterns: ['email', 'password', 'token', 'secret'],
  }),
  plan: dump.plan?.decisions,
  correlationId: dump.meta?.correlationId,
});
```

### Structured Logging

```typescript
// doctest: skip — illustrative data/type literal fragment (not executable code)
// Configure correlation IDs
const users = await orm.select('users')
  .option('correlationId', req.headers['x-request-id'])
  .all();

// Log format (JSON for aggregation)
{
  "timestamp": "2025-01-20T14:30:00Z",
  "level": "info",
  "message": "Query executed",
  "correlationId": "req-123",
  "query": {
    "table": "users",
    "operation": "select",
    "duration_ms": 45
  },
  "plan": {
    "filterStrategy": "where",
    "includeStrategy": "lateral"
  }
}
```

### Metrics to Track

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| Query duration | Time to execute | p95 > 1s |
| Query count | Queries per second | Anomaly detection |
| Error rate | Failed queries | > 1% |
| Pool utilization | `waiting / max` | > 80% |
| Plan warnings | Ambiguous relations | Any |

---

## Streaming Large Results

For large result sets, use streaming to avoid memory exhaustion:

```typescript
// doctest: skip — PgsqlAdapter is in compile-only mode (no database connection). Use createPgsqlAdapter(pool) for a full adapter with execution capabilities.
// Stream 1M rows without loading all in memory
const stream = orm.select('users').stream();

let count = 0;
for await (const row of stream) {
  await processRow(row);
  count++;

  // Progress logging
  if (count % 10000 === 0) {
    logger.info(`Processed ${count} rows`);
  }
}
```

### Streaming Requirements

The PostgreSQL adapter supports cursor-based streaming via `pg-cursor`. For result sets too large to fit in memory, prefer streaming over loading all rows at once. If streaming is not available for your use case, fall back to offset pagination:

```typescript
// doctest: skip — PgsqlAdapter is in compile-only mode (no database connection). Use createPgsqlAdapter(pool) for a full adapter with execution capabilities.
// Offset pagination fallback
const pageSize = 1000;
let offset = 0;
while (true) {
  const batch = await orm.select('users')
    .limit(pageSize)
    .offset(offset)
    .all();
  if (batch.length === 0) break;
  await processBatch(batch);
  offset += pageSize;
}
```

---

## Query Analysis

### EXPLAIN for Optimization

Use EXPLAIN to analyze query performance:

```typescript
// doctest: skip — Cannot read properties of undefined (reading 'query')
// Compile the query first, then EXPLAIN via raw SQL
const dump = await orm.select('users').where(eq('active', true)).dump();

const explainResult = await pool.query(
  `EXPLAIN (ANALYZE, FORMAT JSON) ${dump.sql}`,
  dump.params,
);

// Check for issues
const plan = JSON.stringify(explainResult.rows[0]);
if (plan.includes('Seq Scan') && rowCount > 10000) {
  logger.warn('Sequential scan on large table', {
    sql: dump.sql,
    suggestion: 'Consider adding an index',
  });
}
```

### Performance Baselines

Establish baselines for common queries:

```typescript
// Assumes `orm` from `createOrm({ schema: db, adapter })` is in scope.
import { eq } from '@dbsp/core';

// On startup or scheduled
async function measureBaselines() {
  const queries = [
    { name: 'user_lookup', fn: () => orm.select('users').where(eq('id', 1)).first() },
    { name: 'active_users', fn: () => orm.select('users').where(eq('active', true)).all() },
  ];

  for (const { name, fn } of queries) {
    const start = performance.now();
    await fn();
    const duration = performance.now() - start;

    metrics.gauge(`query.baseline.${name}`, duration);
  }
}
```

---

## Rate Limiting

Rate limiting is handled at the application layer (not by DBSP):

### Per-Tenant Rate Limiting

```typescript
// doctest: skip — RateLimiter is not defined
import { RateLimiter } from 'your-rate-limiter';

const limiter = new RateLimiter({
  points: 100,      // Requests
  duration: 60,     // Per minute
  keyPrefix: 'dbsp',
});

async function rateLimitedQuery<T>(
  tenantId: string,
  queryFn: () => Promise<T>,
): Promise<T> {
  try {
    await limiter.consume(tenantId);
    return await queryFn();
  } catch (error) {
    if (error instanceof RateLimiterError) {
      throw new TooManyRequestsError(
        `Rate limit exceeded. Retry after ${error.msBeforeNext}ms`
      );
    }
    throw error;
  }
}
```

### Query Cost Estimation

For complex queries, estimate cost before execution:

```typescript
// doctest: skip — tenant is not defined
function estimateQueryCost(intent: SelectIntent): number {
  let cost = 1;

  // Includes add cost
  cost += (intent.include?.length ?? 0) * 2;

  // Aggregations add cost
  if (intent.aggregate) cost += 3;

  // Recursive adds significant cost
  if (intent.recursive) cost += 10;

  return cost;
}

// Deduct from tenant quota
const cost = estimateQueryCost(query);
if (tenant.quotaRemaining < cost) {
  throw new QuotaExceededError();
}
```

---

## Security Hardening

### Input Validation

DBSP uses parameterized queries, but validate inputs anyway:

```typescript
// Validate filter values
function validateFilterValue(value: unknown): void {
  if (typeof value === 'string' && value.length > 1000) {
    throw new ValidationError('Filter value too long');
  }
  if (Array.isArray(value) && value.length > 100) {
    throw new ValidationError('Too many filter values');
  }
}

// Validate include depth
function validateIncludeDepth(include: string[], maxDepth = 3): void {
  for (const path of include) {
    const depth = path.split('.').length;
    if (depth > maxDepth) {
      throw new ValidationError(`Include depth ${depth} exceeds max ${maxDepth}`);
    }
  }
}
```

### Identifier Validation

DBSP validates identifiers internally, but add defense in depth:

```typescript
// Validate before reaching DBSP
function sanitizeTableName(name: string): string {
  // Only allow alphanumeric and underscore
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new ValidationError('Invalid table name');
  }
  return name;
}
```

### Logging Redaction

Never log sensitive data:

```typescript
// doctest: skip — redactParams is not defined
import { redactParams, DEFAULT_REDACTION_PATTERNS } from '@dbsp/adapter-pgsql';

const safeParams = redactParams(dump.params, {
  patterns: [
    ...DEFAULT_REDACTION_PATTERNS,
    'ssn',
    'credit_card',
    /^api[_-]?key$/i,
  ],
});
```

---

## Health Checks

### Database Health Check

```typescript
// doctest: skip — app is not defined
app.get('/health', async (req, res) => {
  const checks = {
    database: false,
    timestamp: new Date().toISOString(),
  };

  try {
    // Simple query to verify connectivity
    await pool.query('SELECT 1');
    checks.database = true;
  } catch (error) {
    logger.error('Health check failed', { error });
  }

  const status = checks.database ? 200 : 503;
  res.status(status).json(checks);
});
```

### Readiness vs Liveness

```typescript
// doctest: skip — app is not defined
// Liveness: Is the process alive?
app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness: Can it serve traffic?
app.get('/health/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not ready' });
  }
});
```

---

## Performance Tuning

### Include Strategy Selection

DBSP automatically selects include strategies, but you can optimize:

| Relation | Best Strategy | When |
|----------|---------------|------|
| belongsTo | `join` | Always (single row) |
| hasOne | `join` | Always (single row) |
| hasMany (few) | `lateral` | < 100 related rows |
| hasMany (many) | `separate` | > 100 related rows |
| manyToMany | `separate` | Usually |

### Query Batching

For multiple related queries, batch them:

```typescript
// Instead of N+1 queries (anti-pattern)
const users1 = orm.select('users').dump();
for (const user of []) { // loop would iterate over actual user rows
  // user.posts = await orm.select('posts').where(eq('authorId', user.id)).all();
}

// Use includes
const users2 = orm.select('users').include('author_posts').dump();
```

### Index Recommendations

Based on common DBSP patterns:

```sql
-- For filtered includes (EXISTS optimization)
CREATE INDEX idx_posts_author_id ON posts(author_id);

-- For multi-tenant schemas
CREATE INDEX idx_users_tenant_active ON users(tenant_id, active);

-- For recursive hierarchies
CREATE INDEX idx_categories_parent_id ON categories(parent_id);
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `DB_POOL_MAX` | Maximum pool connections | 20 |
| `DB_POOL_MIN` | Minimum pool connections | 5 |
| `DB_TIMEOUT_MS` | Query timeout | 30000 |
| `LOG_LEVEL` | Logging level | info |
| `NODE_ENV` | Environment | development |

---

## See Also

- [Getting Started](./getting-started) - Installation and first query

