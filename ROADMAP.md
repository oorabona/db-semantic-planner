# Roadmap

## v1.0.0 (current)

- [x] Core query planner with full intent-to-SQL pipeline
- [x] PostgreSQL adapter (native pg, no ORM dependency)
- [x] Fluent query builders (select, insert, update, delete, upsert)
- [x] Include strategies (lateral join, subquery, in-query)
- [x] DDL: schema introspection, comparison, migration generation
- [x] NQL (Natural Query Language) parser
- [x] Expression primitives (op, fn, ref, param, cast, literal)
- [x] Extension helpers (pgvector, ParadeDB BM25)
- [x] Schema scoping (multi-tenant isolation)
- [x] CLI with REPL

## Future

- [ ] Correlated EXISTS subquery in WHERE/SELECT — `exists('relation', (sub) => sub.where(...))` with outer column refs (use case: astix fetchCommunityMeta — `EXISTS(SELECT 1 FROM files f WHERE f.last_parsed > c.created_at)`)
- [ ] CAST expression in column selection — `cast(ref('created_at'), 'text')` (use case: `c.created_at::text` in SELECT)
- [ ] Additional adapters (MySQL, SQLite)
- [ ] Cost-based join reordering
- [ ] Query caching layer
- [ ] VitePress documentation site
- [ ] Interactive playground (Monaco + compile-only mode)

