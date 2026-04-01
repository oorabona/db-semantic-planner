# Migrating from Drizzle

This guide helps you transition from Drizzle ORM to db-semantic-planner. Both tools embrace a SQL-first philosophy, but dbsp adds a semantic planning layer that automates query strategy decisions and provides full observability.

## Key Differences

| Concept | Drizzle | dbsp |
|---------|---------|------|
| Schema definition | `pgTable()` (TypeScript) | `schema()` (TypeScript) |
| Relation loading | `with: { posts: true }` or manual joins | `.include('posts')` (auto-strategy) |
| Query building | `db.select().from(users)` | `orm.select('users')` |
| Filtering | `eq(users.active, true)` | `eq('active', true)` |
| Observability | `.toSQL()` | `.dump()` (plan + SQL + params) |
| Join strategy | Manual choice | Automatic (EXISTS vs JOIN vs lateral) |
| Multi-tenant | Manual schema prefix | `.withSchema('tenant')` built-in |

## Step-by-Step Migration

*Coming soon.* See the [Getting Started guide](getting-started.md) to learn dbsp's API.

## Quick Translation Reference

### Drizzle → dbsp

| Drizzle | dbsp |
|---------|------|
| `db.select().from(users)` | `orm.select('users').all()` |
| `db.select().from(users).where(eq(users.active, true))` | `orm.select('users').where(eq('active', true)).all()` |
| `db.insert(users).values(data)` | `orm.insert('users').values(data).execute()` |
| `db.update(users).set(data).where(...)` | `orm.update('users').set(data).where(...).execute()` |
| `db.delete(users).where(...)` | `orm.delete('users').where(...).execute()` |
| `.toSQL()` | `.dump()` |
