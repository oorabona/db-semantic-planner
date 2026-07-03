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

- [x] Correlated EXISTS subquery in WHERE/SELECT — `exists('relation', { where: ... outerRef(...) })` with outer column refs (e.g. `EXISTS(SELECT 1 FROM files f WHERE f.last_parsed > c.created_at)`)
- [x] CAST expression in column selection — `cast(ref('created_at'), 'text')` (`c.created_at::text` in SELECT)
- [ ] Additional adapters (MySQL, SQLite) — see #102
- [ ] ~~Cost-based join reordering~~ — out of scope by design (see CLAUDE.md § Out of Scope; #109)
- [ ] Query caching layer — see #110
- [x] VitePress documentation site
- [x] Interactive playground (Monaco + compile-only mode)

