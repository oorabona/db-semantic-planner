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

- [ ] Additional adapters (MySQL, SQLite)
- [ ] Cost-based join reordering
- [ ] Query caching layer
- [ ] VitePress documentation site
- [ ] Interactive playground (Monaco + compile-only mode)
