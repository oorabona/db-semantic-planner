# Migrating from Prisma

This guide helps you transition from Prisma to db-semantic-planner. Both tools offer type-safe database access, but dbsp takes an intent-first approach that gives you more control and observability over query execution.

## Key Differences

| Concept | Prisma | dbsp |
|---------|--------|------|
| Schema definition | `schema.prisma` (DSL) | `schema()` (TypeScript) |
| Client generation | `prisma generate` (codegen) | No codegen needed |
| Relations | `include: { posts: true }` | `.include('posts')` |
| Filtering | `where: { active: true }` | `.where(eq('active', true))` |
| Observability | Logging middleware | `.dump()` (plan + SQL + params) |
| Multi-tenant | Manual schema switching | `.withSchema('tenant')` built-in |
| Migrations | `prisma migrate` | `dbsp verify` + `generateMigrationSQL()` |

## Step-by-Step Migration

*Coming soon.* In the meantime, see the [Getting Started guide](getting-started.md) for a full walkthrough of dbsp's API.

## Quick Translation Reference

### Prisma → dbsp

| Prisma | dbsp |
|--------|------|
| `prisma.user.findMany()` | `orm.select('users').all()` |
| `prisma.user.findUnique({ where: { id } })` | `orm.select('users').where(eq('id', id)).first()` |
| `prisma.user.create({ data })` | `orm.insert('users').values(data).execute()` |
| `prisma.user.update({ where, data })` | `orm.update('users').set(data).where(...).execute()` |
| `prisma.user.delete({ where })` | `orm.delete('users').where(...).execute()` |
| `include: { posts: true }` | `.include('posts')` |
| `select: { name: true }` | `.columns(['name'])` |
