# Quickstart Guide

A progressive tutorial from basic to advanced queries with **real data at every step**.

Each chapter uses a different schema, building in complexity.

---

## Chapter 0: Prerequisites

### Install Dependencies

```bash
git clone https://github.com/your-org/db-semantic-planner
cd db-semantic-planner
pnpm install
```

### Start PostgreSQL

```bash
# Start PostgreSQL with full extension support
docker run -d \
  --name pg-demo \
  -e POSTGRES_PASSWORD=demo \
  -p 5432:5432 \
  oorabona/postgres:17-full-alpine

# Wait for startup
sleep 3

# Create demo database
docker exec pg-demo createdb -U postgres demo
```

### Verify Connection

```bash
docker exec -it pg-demo psql -U postgres -d demo -c "SELECT version();"
```

You're ready! Each chapter will:
1. Generate DDL for the schema
2. Load seed data
3. Connect REPL with execution mode
4. Run queries with real results

---

## Chapter 1: Minimal Schema (users + posts)

**New concepts:** `select`, `where`, `include`, `limit`, `offset`

### 1.1 Setup Database

```bash
# Generate DDL
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts -o /tmp/minimal.sql

# Apply to database
docker exec -i pg-demo psql -U postgres -d demo < /tmp/minimal.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/minimal.seed.sql
```

### 1.2 Connect REPL (Execution Mode)

```bash
pnpm dbsp repl \
  --schema ./examples/minimal.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --exec
```

The `--exec` flag enables execution mode: queries run against the database and show real results.

### 1.3 Explore Schema

```
dbsp> .tables
```
```
Tables (2):
  - users
  - posts
```

```
dbsp> .schema users
```
```
Table: users
Columns:
  - id: integer (NOT NULL)
  - name: string (NOT NULL)
  - email: string (NOT NULL, UNIQUE)
```

```
dbsp> .relations posts
```
```
Relations for posts:
  - posts.user: belongsTo → users
  - users.posts: hasMany → posts (inverse)
```

### 1.4 Basic SELECT

**Select all users:**
```
dbsp> users
```
```
┌────┬─────────┬─────────────────────────┐
│ id │ name    │ email                   │
├────┼─────────┼─────────────────────────┤
│  1 │ Alice   │ alice@example.com       │
│  2 │ Bob     │ bob@example.com         │
│  3 │ Charlie │ charlie@example.com     │
└────┴─────────┴─────────────────────────┘
3 rows (8ms)
```

**Select all posts:**
```
dbsp> posts
```
```
┌────┬───────────────────┬────────────────────────────────────────┬─────────┐
│ id │ title             │ content                                │ user_id │
├────┼───────────────────┼────────────────────────────────────────┼─────────┤
│  1 │ Hello World       │ My first post!                         │       1 │
│  2 │ Getting Started   │ Here is how to begin...                │       1 │
│  3 │ Tips and Tricks   │ Some useful tips for beginners.        │       2 │
│  4 │ Advanced Topics   │ NULL                                   │       2 │
│  5 │ Final Thoughts    │ Wrapping up the series.                │       3 │
└────┴───────────────────┴────────────────────────────────────────┴─────────┘
5 rows (5ms)
```

### 1.5 WHERE Clause

**Filter by equality:**
```
dbsp> users where name = 'Alice'
```
```
┌────┬───────┬───────────────────┐
│ id │ name  │ email             │
├────┼───────┼───────────────────┤
│  1 │ Alice │ alice@example.com │
└────┴───────┴───────────────────┘
1 row (4ms)
```

**Filter by user_id:**
```
dbsp> posts where user_id = 1
```
```
┌────┬─────────────────┬──────────────────────────┬─────────┐
│ id │ title           │ content                  │ user_id │
├────┼─────────────────┼──────────────────────────┼─────────┤
│  1 │ Hello World     │ My first post!           │       1 │
│  2 │ Getting Started │ Here is how to begin...  │       1 │
└────┴─────────────────┴──────────────────────────┴─────────┘
2 rows (4ms)
```

**Filter with NULL:**
```
dbsp> posts where content is null
```
```
┌────┬─────────────────┬─────────┬─────────┐
│ id │ title           │ content │ user_id │
├────┼─────────────────┼─────────┼─────────┤
│  4 │ Advanced Topics │ NULL    │       2 │
└────┴─────────────────┴─────────┴─────────┘
1 row (3ms)
```

**Multiple conditions:**
```
dbsp> posts where user_id = 2 and content is not null
```
```
┌────┬─────────────────┬──────────────────────────────────┬─────────┐
│ id │ title           │ content                          │ user_id │
├────┼─────────────────┼──────────────────────────────────┼─────────┤
│  3 │ Tips and Tricks │ Some useful tips for beginners.  │       2 │
└────┴─────────────────┴──────────────────────────────────┴─────────┘
1 row (3ms)
```

### 1.6 INCLUDE (Joins)

**Users with their posts:**
```
dbsp> users include posts
```
```
┌────┬─────────┬─────────────────────────┬───────────────────────────────────────────┐
│ id │ name    │ email                   │ posts                                     │
├────┼─────────┼─────────────────────────┼───────────────────────────────────────────┤
│  1 │ Alice   │ alice@example.com       │ [{id:1,title:"Hello World",...},          │
│    │         │                         │  {id:2,title:"Getting Started",...}]      │
│  2 │ Bob     │ bob@example.com         │ [{id:3,title:"Tips and Tricks",...},      │
│    │         │                         │  {id:4,title:"Advanced Topics",...}]      │
│  3 │ Charlie │ charlie@example.com     │ [{id:5,title:"Final Thoughts",...}]       │
└────┴─────────┴─────────────────────────┴───────────────────────────────────────────┘
3 rows (12ms)
```

**Posts with their author:**
```
dbsp> posts include user
```
```
┌────┬───────────────────┬─────────┬───────────────────────────────────────┐
│ id │ title             │ user_id │ user                                  │
├────┼───────────────────┼─────────┼───────────────────────────────────────┤
│  1 │ Hello World       │       1 │ {id:1,name:"Alice",email:"alice@..."}│
│  2 │ Getting Started   │       1 │ {id:1,name:"Alice",email:"alice@..."}│
│  3 │ Tips and Tricks   │       2 │ {id:2,name:"Bob",email:"bob@..."}    │
│  4 │ Advanced Topics   │       2 │ {id:2,name:"Bob",email:"bob@..."}    │
│  5 │ Final Thoughts    │       3 │ {id:3,name:"Charlie",email:"..."}    │
└────┴───────────────────┴─────────┴───────────────────────────────────────┘
5 rows (8ms)
```

### 1.7 LIMIT and OFFSET

**First 2 posts:**
```
dbsp> posts limit 2
```
```
┌────┬─────────────────┬────────────────────────┬─────────┐
│ id │ title           │ content                │ user_id │
├────┼─────────────────┼────────────────────────┼─────────┤
│  1 │ Hello World     │ My first post!         │       1 │
│  2 │ Getting Started │ Here is how to begin...│       1 │
└────┴─────────────────┴────────────────────────┴─────────┘
2 rows (4ms)
```

**Skip first 2, get next 2:**
```
dbsp> posts limit 2 offset 2
```
```
┌────┬─────────────────┬──────────────────────────────────┬─────────┐
│ id │ title           │ content                          │ user_id │
├────┼─────────────────┼──────────────────────────────────┼─────────┤
│  3 │ Tips and Tricks │ Some useful tips for beginners.  │       2 │
│  4 │ Advanced Topics │ NULL                             │       2 │
└────┴─────────────────┴──────────────────────────────────┴─────────┘
2 rows (4ms)
```

### 1.8 Cleanup

```
dbsp> .exit
```

---

## Chapter 2: Blog Schema

**New concepts:** M:N relations, aggregates (`count`, `sum`, `avg`), `group by`, `distinct`

### 2.1 Setup Database

```bash
# Drop and recreate for clean state
docker exec pg-demo psql -U postgres -d demo -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Generate and apply DDL
pnpm dbsp generate ddl --schema ./examples/blog.schema.ts -o /tmp/blog.sql
docker exec -i pg-demo psql -U postgres -d demo < /tmp/blog.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/blog.seed.sql
```

### 2.2 Connect REPL

```bash
pnpm dbsp repl \
  --schema ./examples/blog.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --exec
```

### 2.3 Explore Schema

```
dbsp> .tables
```
```
Tables (5):
  - authors
  - posts
  - comments
  - tags
  - post_tags
```

```
dbsp> .relations posts
```
```
Relations for posts:
  - posts.author: belongsTo → authors
  - posts.comments: hasMany → comments
  - posts.tags: manyToMany → tags (via post_tags)
```

### 2.4 Basic Queries with Data

**Authors:**
```
dbsp> authors
```
```
┌────┬─────────────┬──────────────────┬────────────────────────────────────────────────────┐
│ id │ name        │ email            │ bio                                                │
├────┼─────────────┼──────────────────┼────────────────────────────────────────────────────┤
│  1 │ Jane Doe    │ jane@blog.com    │ Senior tech writer and developer advocate.         │
│  2 │ John Smith  │ john@blog.com    │ Full-stack developer passionate about databases.   │
│  3 │ Emily Chen  │ emily@blog.com   │ NULL                                               │
└────┴─────────────┴──────────────────┴────────────────────────────────────────────────────┘
3 rows
```

**Posts:**
```
dbsp> posts
```
```
┌────┬────────────────────────────────────┬───────────┬───────────┬─────────────────────┐
│ id │ title                              │ published │ author_id │ created_at          │
├────┼────────────────────────────────────┼───────────┼───────────┼─────────────────────┤
│  1 │ Getting Started with PostgreSQL    │ true      │         1 │ 2024-01-05 10:00:00 │
│  2 │ TypeScript Best Practices 2024     │ true      │         1 │ 2024-01-10 14:30:00 │
│  3 │ Query Optimization Techniques      │ true      │         2 │ 2024-01-12 09:00:00 │
│  4 │ Introduction to Range Types        │ true      │         2 │ 2024-01-15 11:00:00 │
│  5 │ Draft: Advanced Indexing           │ false     │         2 │ 2024-01-18 16:00:00 │
│  6 │ Why Type Safety Matters            │ true      │         3 │ 2024-01-20 08:00:00 │
└────┴────────────────────────────────────┴───────────┴───────────┴─────────────────────┘
6 rows
```

**Tags:**
```
dbsp> tags
```
```
┌────┬────────────────┬────────────────┐
│ id │ name           │ slug           │
├────┼────────────────┼────────────────┤
│  1 │ PostgreSQL     │ postgresql     │
│  2 │ TypeScript     │ typescript     │
│  3 │ Tutorial       │ tutorial       │
│  4 │ Database       │ database       │
│  5 │ Performance    │ performance    │
│  6 │ Best Practices │ best-practices │
└────┴────────────────┴────────────────┘
6 rows
```

### 2.5 Filtering

**Published posts only:**
```
dbsp> posts where published = true
```
```
┌────┬────────────────────────────────────┬───────────┬───────────┐
│ id │ title                              │ published │ author_id │
├────┼────────────────────────────────────┼───────────┼───────────┤
│  1 │ Getting Started with PostgreSQL    │ true      │         1 │
│  2 │ TypeScript Best Practices 2024     │ true      │         1 │
│  3 │ Query Optimization Techniques      │ true      │         2 │
│  4 │ Introduction to Range Types        │ true      │         2 │
│  6 │ Why Type Safety Matters            │ true      │         3 │
└────┴────────────────────────────────────┴───────────┴───────────┘
5 rows
```

**Approved comments:**
```
dbsp> comments where approved = true
```
```
┌────┬─────────┬───────────────┬────────────────────────────────────────┐
│ id │ post_id │ author_name   │ content                                │
├────┼─────────┼───────────────┼────────────────────────────────────────┤
│  1 │       1 │ Alex Reader   │ Great introduction! Very helpful.      │
│  2 │       1 │ Sam Dev       │ Could you cover more advanced topics?  │
│  3 │       2 │ Chris Coder   │ This is exactly what I needed!         │
│  4 │       3 │ Pat DBA       │ Excellent tips on EXPLAIN ANALYZE.     │
│  5 │       4 │ Jordan Query  │ Range types are so useful!             │
│  7 │       6 │ Taylor Types  │ TypeScript changed my workflow.        │
└────┴─────────┴───────────────┴────────────────────────────────────────┘
6 rows
```

**Unapproved (spam) comments:**
```
dbsp> comments where approved = false
```
```
┌────┬─────────┬───────────┬────────────────────┐
│ id │ post_id │ author_name │ content          │
├────┼─────────┼───────────┼────────────────────┤
│  6 │       4 │ Spam Bot  │ Buy cheap watches! │
└────┴─────────┴───────────┴────────────────────┘
1 row
```

### 2.6 Includes with Filters

**Authors with their published posts:**
```
dbsp> authors include posts where published = true
```
```
┌────┬─────────────┬────────────────────────────────────────────────────────────────────┐
│ id │ name        │ posts                                                              │
├────┼─────────────┼────────────────────────────────────────────────────────────────────┤
│  1 │ Jane Doe    │ [{title:"Getting Started with PostgreSQL",...},                    │
│    │             │  {title:"TypeScript Best Practices 2024",...}]                     │
│  2 │ John Smith  │ [{title:"Query Optimization Techniques",...},                      │
│    │             │  {title:"Introduction to Range Types",...}]                        │
│  3 │ Emily Chen  │ [{title:"Why Type Safety Matters",...}]                            │
└────┴─────────────┴────────────────────────────────────────────────────────────────────┘
3 rows
```

**Posts with approved comments only:**
```
dbsp> posts include comments where approved = true
```
```
┌────┬────────────────────────────────────┬────────────────────────────────────────────────────┐
│ id │ title                              │ comments                                           │
├────┼────────────────────────────────────┼────────────────────────────────────────────────────┤
│  1 │ Getting Started with PostgreSQL    │ [{author_name:"Alex Reader",...},                  │
│    │                                    │  {author_name:"Sam Dev",...}]                      │
│  2 │ TypeScript Best Practices 2024     │ [{author_name:"Chris Coder",...}]                  │
│  3 │ Query Optimization Techniques      │ [{author_name:"Pat DBA",...}]                      │
│  4 │ Introduction to Range Types        │ [{author_name:"Jordan Query",...}]                 │
│  5 │ Draft: Advanced Indexing           │ []                                                 │
│  6 │ Why Type Safety Matters            │ [{author_name:"Taylor Types",...}]                 │
└────┴────────────────────────────────────┴────────────────────────────────────────────────────┘
6 rows
```

### 2.7 Many-to-Many Relations (Tags)

**Posts with their tags:**
```
dbsp> posts include tags
```
```
┌────┬────────────────────────────────────┬──────────────────────────────────────────────┐
│ id │ title                              │ tags                                         │
├────┼────────────────────────────────────┼──────────────────────────────────────────────┤
│  1 │ Getting Started with PostgreSQL    │ [{name:"PostgreSQL"},{name:"Tutorial"},      │
│    │                                    │  {name:"Database"}]                          │
│  2 │ TypeScript Best Practices 2024     │ [{name:"TypeScript"},{name:"Best Practices"}]│
│  3 │ Query Optimization Techniques      │ [{name:"Database"},{name:"Performance"}]     │
│  4 │ Introduction to Range Types        │ [{name:"PostgreSQL"},{name:"Database"},      │
│    │                                    │  {name:"Tutorial"}]                          │
│  5 │ Draft: Advanced Indexing           │ [{name:"Database"},{name:"Performance"}]     │
│  6 │ Why Type Safety Matters            │ [{name:"TypeScript"},{name:"Best Practices"}]│
└────┴────────────────────────────────────┴──────────────────────────────────────────────┘
6 rows
```

**Tags with their posts:**
```
dbsp> tags include posts where published = true
```
```
┌────┬────────────────┬─────────────────────────────────────────────────────────────────────┐
│ id │ name           │ posts                                                               │
├────┼────────────────┼─────────────────────────────────────────────────────────────────────┤
│  1 │ PostgreSQL     │ [{title:"Getting Started with PostgreSQL",...},                     │
│    │                │  {title:"Introduction to Range Types",...}]                         │
│  2 │ TypeScript     │ [{title:"TypeScript Best Practices 2024",...},                      │
│    │                │  {title:"Why Type Safety Matters",...}]                             │
│  3 │ Tutorial       │ [{title:"Getting Started with PostgreSQL",...},                     │
│    │                │  {title:"Introduction to Range Types",...}]                         │
│  4 │ Database       │ [{title:"Getting Started with PostgreSQL",...},                     │
│    │                │  {title:"Query Optimization Techniques",...},                       │
│    │                │  {title:"Introduction to Range Types",...}]                         │
│  5 │ Performance    │ [{title:"Query Optimization Techniques",...}]                       │
│  6 │ Best Practices │ [{title:"TypeScript Best Practices 2024",...},                      │
│    │                │  {title:"Why Type Safety Matters",...}]                             │
└────┴────────────────┴─────────────────────────────────────────────────────────────────────┘
6 rows
```

### 2.8 Aggregates

**Count posts per author:**
```
dbsp> posts aggregate count by author_id
```
```
┌───────────┬───────┐
│ author_id │ count │
├───────────┼───────┤
│         1 │     2 │
│         2 │     3 │
│         3 │     1 │
└───────────┴───────┘
3 rows
```

**Count published posts:**
```
dbsp> posts where published = true aggregate count
```
```
┌───────┐
│ count │
├───────┤
│     5 │
└───────┘
1 row
```

**Count comments per post:**
```
dbsp> comments aggregate count by post_id
```
```
┌─────────┬───────┐
│ post_id │ count │
├─────────┼───────┤
│       1 │     2 │
│       2 │     1 │
│       3 │     1 │
│       4 │     2 │
│       6 │     1 │
└─────────┴───────┘
5 rows
```

### 2.9 DISTINCT

**Unique author names who have approved comments:**
```
dbsp> comments where approved = true select distinct author_name
```
```
┌───────────────┐
│ author_name   │
├───────────────┤
│ Alex Reader   │
│ Sam Dev       │
│ Chris Coder   │
│ Pat DBA       │
│ Jordan Query  │
│ Taylor Types  │
└───────────────┘
6 rows
```

---

## Chapter 3: Blog-Extended Schema

**New concepts:** Hierarchical categories (self-referential), complex filters, `order by`, combined conditions

### 3.1 Setup Database

```bash
# Reset database
docker exec pg-demo psql -U postgres -d demo -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Generate and apply DDL
pnpm dbsp generate ddl --schema ./examples/blog-extended.schema.ts -o /tmp/blog-extended.sql
docker exec -i pg-demo psql -U postgres -d demo < /tmp/blog-extended.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/blog-extended.seed.sql
```

### 3.2 Connect REPL

```bash
pnpm dbsp repl \
  --schema ./examples/blog-extended.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --exec
```

### 3.3 Explore Data

**Authors:**
```
dbsp> authors
```
```
┌────┬────────────────┬────────────────────────┬────────┐
│ id │ name           │ email                  │ active │
├────┼────────────────┼────────────────────────┼────────┤
│  1 │ Alice Johnson  │ alice@example.com      │ true   │
│  2 │ Bob Smith      │ bob@example.com        │ true   │
│  3 │ Charlie Brown  │ charlie@example.com    │ false  │
└────┴────────────────┴────────────────────────┴────────┘
3 rows
```

**Hierarchical categories:**
```
dbsp> categories
```
```
┌────┬─────────────────┬───────────┐
│ id │ name            │ parent_id │
├────┼─────────────────┼───────────┤
│  1 │ Technology      │ NULL      │
│  2 │ Web Development │         1 │
│  3 │ Databases       │         1 │
│  4 │ Lifestyle       │ NULL      │
└────┴─────────────────┴───────────┘
4 rows
```

**Root categories (no parent):**
```
dbsp> categories where parent_id is null
```
```
┌────┬────────────┬───────────┐
│ id │ name       │ parent_id │
├────┼────────────┼───────────┤
│  1 │ Technology │ NULL      │
│  4 │ Lifestyle  │ NULL      │
└────┴────────────┴───────────┘
2 rows
```

**Categories with their children:**
```
dbsp> categories include children
```
```
┌────┬─────────────────┬───────────┬──────────────────────────────────────────────────────┐
│ id │ name            │ parent_id │ children                                             │
├────┼─────────────────┼───────────┼──────────────────────────────────────────────────────┤
│  1 │ Technology      │ NULL      │ [{name:"Web Development",...},{name:"Databases",...}]│
│  2 │ Web Development │         1 │ []                                                   │
│  3 │ Databases       │         1 │ []                                                   │
│  4 │ Lifestyle       │ NULL      │ []                                                   │
└────┴─────────────────┴───────────┴──────────────────────────────────────────────────────┘
4 rows
```

**Root categories with their children:**
```
dbsp> categories where parent_id is null include children
```
```
┌────┬────────────┬───────────┬──────────────────────────────────────────────────────┐
│ id │ name       │ parent_id │ children                                             │
├────┼────────────┼───────────┼──────────────────────────────────────────────────────┤
│  1 │ Technology │ NULL      │ [{name:"Web Development",...},{name:"Databases",...}]│
│  4 │ Lifestyle  │ NULL      │ []                                                   │
└────┴────────────┴───────────┴──────────────────────────────────────────────────────┘
2 rows
```

**Tags:**
```
dbsp> tags
```
```
┌────┬────────────┬────────────┐
│ id │ name       │ slug       │
├────┼────────────┼────────────┤
│  1 │ TypeScript │ typescript │
│  2 │ PostgreSQL │ postgresql │
│  3 │ Tutorial   │ tutorial   │
│  4 │ Advanced   │ advanced   │
│  5 │ Beginner   │ beginner   │
└────┴────────────┴────────────┘
5 rows
```

**Posts (8 total - mix of published/draft, featured, various view counts):**
```
dbsp> posts
```
```
┌────┬────────────────────────────────┬───────────┬──────────┬────────────┬─────────────┐
│ id │ title                          │ published │ featured │ view_count │ category_id │
├────┼────────────────────────────────┼───────────┼──────────┼────────────┼─────────────┤
│  1 │ TypeScript Fundamentals        │ true      │ true     │       1500 │           2 │
│  2 │ Advanced TypeScript            │ true      │ false    │        800 │           2 │
│  3 │ PostgreSQL Deep Dive           │ true      │ true     │       2000 │           3 │
│  4 │ MongoDB vs PostgreSQL          │ true      │ false    │        600 │           3 │
│  5 │ Work-Life Balance              │ true      │ false    │        300 │           4 │
│  6 │ Draft: React Patterns          │ false     │ false    │          0 │           2 │
│  7 │ Draft: Redis Caching           │ false     │ false    │          0 │           3 │
│  8 │ Inactive Author Post           │ true      │ false    │         50 │           1 │
└────┴────────────────────────────────┴───────────┴──────────┴────────────┴─────────────┘
8 rows
```

**Comments (15 total - mix of approved/pending):**
```
dbsp> comments limit 10
```
```
┌────┬─────────┬─────────────┬──────────────────────────────┬──────────┐
│ id │ post_id │ author_name │ content                      │ approved │
├────┼─────────┼─────────────┼──────────────────────────────┼──────────┤
│  1 │       1 │ David       │ Great intro!                 │ true     │
│  2 │       1 │ Eva         │ Very helpful!                │ true     │
│  3 │       1 │ Spam Bot    │ Buy crypto now!!!            │ false    │
│  4 │       2 │ Frank       │ Mind-blowing!                │ true     │
│  5 │       2 │ Grace       │ Need more examples           │ true     │
│  6 │       3 │ Henry       │ PostgreSQL FTW!              │ true     │
│  7 │       3 │ Ivy         │ Clear explanation            │ true     │
│  8 │       3 │ Jack        │ More DB content please       │ true     │
│  9 │       3 │ Spammer     │ Visit my site!!!             │ false    │
│ 10 │       4 │ Kate        │ Good comparison              │ true     │
└────┴─────────┴─────────────┴──────────────────────────────┴──────────┘
10 rows (15 total)
```

### 3.4 Featured and Popular Posts

**Featured posts:**
```
dbsp> posts where featured = true
```
```
┌────┬────────────────────────────────────┬───────────┬──────────┬────────────┐
│ id │ title                              │ published │ featured │ view_count │
├────┼────────────────────────────────────┼───────────┼──────────┼────────────┤
│  1 │ Getting Started with PostgreSQL    │ true      │ true     │       1500 │
│  3 │ Modern JavaScript Patterns         │ true      │ true     │       2200 │
└────┴────────────────────────────────────┴───────────┴──────────┴────────────┘
2 rows
```

**Popular posts (> 1000 views):**
```
dbsp> posts where view_count > 1000
```
```
┌────┬────────────────────────────────────┬────────────┐
│ id │ title                              │ view_count │
├────┼────────────────────────────────────┼────────────┤
│  1 │ Getting Started with PostgreSQL    │       1500 │
│  3 │ Modern JavaScript Patterns         │       2200 │
│  5 │ TypeScript Tips                    │       1100 │
└────┴────────────────────────────────────┴────────────┘
3 rows
```

**Featured AND popular:**
```
dbsp> posts where featured = true and view_count > 1500
```
```
┌────┬────────────────────────────────┬──────────┬────────────┐
│ id │ title                          │ featured │ view_count │
├────┼────────────────────────────────┼──────────┼────────────┤
│  3 │ Modern JavaScript Patterns     │ true     │       2200 │
└────┴────────────────────────────────┴──────────┴────────────┘
1 row
```

### 3.5 Complex Nested Includes

**Active authors with published posts and approved comments:**
```
dbsp> authors where active = true include posts where published = true include comments where approved = true
```
```
┌────┬─────────────┬────────┬────────────────────────────────────────────────────────────────┐
│ id │ name        │ active │ posts                                                          │
├────┼─────────────┼────────┼────────────────────────────────────────────────────────────────┤
│  1 │ Jane Doe    │ true   │ [{title:"Getting Started...",comments:[{author_name:"Alex"},   │
│    │             │        │  {author_name:"Sam"}]},{title:"TypeScript Tips",comments:[]}]  │
│  2 │ John Smith  │ true   │ [{title:"Modern JavaScript...",comments:[{author_name:"Chris"}]}]│
└────┴─────────────┴────────┴────────────────────────────────────────────────────────────────┘
2 rows
```

**Categories with posts and post counts:**
```
dbsp> categories include posts aggregate count by category_id
```
```
┌────┬─────────────────────┬────────────┬───────┐
│ id │ name                │ post_count │ posts │
├────┼─────────────────────┼────────────┼───────┤
│  2 │ Programming         │          3 │ [...] │
│  3 │ Databases           │          2 │ [...] │
│  7 │ Productivity        │          1 │ [...] │
└────┴─────────────────────┴────────────┴───────┘
3 rows
```

### 3.6 ORDER BY

**Posts by view count (descending):**
```
dbsp> posts order by view_count desc
```
```
┌────┬────────────────────────────────────┬────────────┐
│ id │ title                              │ view_count │
├────┼────────────────────────────────────┼────────────┤
│  3 │ Modern JavaScript Patterns         │       2200 │
│  1 │ Getting Started with PostgreSQL    │       1500 │
│  5 │ TypeScript Tips                    │       1100 │
│  2 │ Database Design Principles         │        800 │
│  4 │ Productivity Hacks                 │        600 │
│  6 │ Draft: New Ideas                   │          0 │
└────┴────────────────────────────────────┴────────────┘
6 rows
```

**Top 3 most viewed:**
```
dbsp> posts order by view_count desc limit 3
```
```
┌────┬────────────────────────────────────┬────────────┐
│ id │ title                              │ view_count │
├────┼────────────────────────────────────┼────────────┤
│  3 │ Modern JavaScript Patterns         │       2200 │
│  1 │ Getting Started with PostgreSQL    │       1500 │
│  5 │ TypeScript Tips                    │       1100 │
└────┴────────────────────────────────────┴────────────┘
3 rows
```

---

## Chapter 4: Scheduling Schema (PostgreSQL Ranges)

**New concepts:** PostgreSQL range types (`daterange`, `tstzrange`, `int4range`), range operators

### 4.1 Setup Database

```bash
# Reset database
docker exec pg-demo psql -U postgres -d demo -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Generate and apply DDL
pnpm dbsp generate ddl --schema ./examples/scheduling.schema.ts -o /tmp/scheduling.sql
docker exec -i pg-demo psql -U postgres -d demo < /tmp/scheduling.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/scheduling.seed.sql
```

### 4.2 Connect REPL

```bash
pnpm dbsp repl \
  --schema ./examples/scheduling.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --exec
```

### 4.3 Explore Data

**Rooms:**
```
dbsp> rooms
```
```
┌────┬──────────────────────┬──────────┬───────┐
│ id │ name                 │ capacity │ floor │
├────┼──────────────────────┼──────────┼───────┤
│  1 │ Conference Room A    │       10 │     1 │
│  2 │ Conference Room B    │       20 │     1 │
│  3 │ Board Room           │       30 │     2 │
│  4 │ Training Room        │       50 │     3 │
│  5 │ Small Meeting Room   │        4 │     1 │
└────┴──────────────────────┴──────────┴───────┘
5 rows
```

**Room bookings (with daterange):**
```
dbsp> room_bookings
```
```
┌────┬─────────┬───────────────┬─────────────────────────────┬──────────────────────┐
│ id │ room_id │ booked_by     │ booking_period              │ purpose              │
├────┼─────────┼───────────────┼─────────────────────────────┼──────────────────────┤
│  1 │       1 │ Alice         │ [2024-01-15,2024-01-16)     │ Team standup         │
│  2 │       1 │ Bob           │ [2024-01-17,2024-01-19)     │ Sprint planning      │
│  3 │       2 │ Charlie       │ [2024-01-15,2024-01-18)     │ Workshop             │
│  4 │       3 │ David         │ [2024-01-20,2024-01-21)     │ Board meeting        │
│  5 │       4 │ Eve           │ [2024-01-22,2024-01-26)     │ Training session     │
│  6 │       1 │ Frank         │ [2024-01-25,2024-01-26)     │ Client meeting       │
└────┴─────────┴───────────────┴─────────────────────────────┴──────────────────────┘
6 rows
```

**Events (with tstzrange):**
```
dbsp> events
```
```
┌────┬─────────────────────────────┬─────────┬────────────────────────────────────────────────────┐
│ id │ title                       │ room_id │ time_slot                                          │
├────┼─────────────────────────────┼─────────┼────────────────────────────────────────────────────┤
│  1 │ Morning Standup             │       1 │ [2024-01-15 09:00:00+00,2024-01-15 09:30:00+00)    │
│  2 │ Product Demo                │       2 │ [2024-01-15 14:00:00+00,2024-01-15 16:00:00+00)    │
│  3 │ Tech Talk: PostgreSQL       │       3 │ [2024-01-16 10:00:00+00,2024-01-16 12:00:00+00)    │
│  4 │ All-hands Meeting           │       4 │ [2024-01-17 15:00:00+00,2024-01-17 17:00:00+00)    │
│  5 │ Interview: Senior Dev       │       5 │ [2024-01-18 11:00:00+00,2024-01-18 12:00:00+00)    │
└────┴─────────────────────────────┴─────────┴────────────────────────────────────────────────────┘
5 rows
```

**Price tiers (with int4range):**
```
dbsp> price_tiers
```
```
┌────┬──────────────────┬────────────────┬────────────┐
│ id │ product_name     │ quantity_range │ unit_price │
├────┼──────────────────┼────────────────┼────────────┤
│  1 │ Widget A         │ [1,10)         │      10.00 │
│  2 │ Widget A         │ [10,50)        │       8.50 │
│  3 │ Widget A         │ [50,100)       │       7.00 │
│  4 │ Widget A         │ [100,)         │       5.50 │
│  5 │ Widget B         │ [1,25)         │      15.00 │
│  6 │ Widget B         │ [25,100)       │      12.00 │
│  7 │ Widget B         │ [100,)         │       9.00 │
└────┴──────────────────┴────────────────┴────────────┘
7 rows
```

### 4.4 Range Operators

**Bookings that overlap with a specific period:**
```
dbsp> room_bookings where booking_period overlaps [2024-01-16,2024-01-20)
```
```
┌────┬─────────┬───────────────┬─────────────────────────────┬──────────────────────┐
│ id │ room_id │ booked_by     │ booking_period              │ purpose              │
├────┼─────────┼───────────────┼─────────────────────────────┼──────────────────────┤
│  2 │       1 │ Bob           │ [2024-01-17,2024-01-19)     │ Sprint planning      │
│  3 │       2 │ Charlie       │ [2024-01-15,2024-01-18)     │ Workshop             │
│  4 │       3 │ David         │ [2024-01-20,2024-01-21)     │ Board meeting        │
└────┴─────────┴───────────────┴─────────────────────────────┴──────────────────────┘
3 rows
```

**Bookings contained within a month:**
```
dbsp> room_bookings where booking_period containedBy [2024-01-01,2024-02-01)
```
```
┌────┬─────────┬───────────────┬─────────────────────────────┬──────────────────────┐
│ id │ room_id │ booked_by     │ booking_period              │ purpose              │
├────┼─────────┼───────────────┼─────────────────────────────┼──────────────────────┤
│  1 │       1 │ Alice         │ [2024-01-15,2024-01-16)     │ Team standup         │
│  2 │       1 │ Bob           │ [2024-01-17,2024-01-19)     │ Sprint planning      │
│  3 │       2 │ Charlie       │ [2024-01-15,2024-01-18)     │ Workshop             │
│  4 │       3 │ David         │ [2024-01-20,2024-01-21)     │ Board meeting        │
│  5 │       4 │ Eve           │ [2024-01-22,2024-01-26)     │ Training session     │
│  6 │       1 │ Frank         │ [2024-01-25,2024-01-26)     │ Client meeting       │
└────┴─────────┴───────────────┴─────────────────────────────┴──────────────────────┘
6 rows
```

**Price tier for quantity 25:**
```
dbsp> price_tiers where quantity_range contains 25
```
```
┌────┬──────────────────┬────────────────┬────────────┐
│ id │ product_name     │ quantity_range │ unit_price │
├────┼──────────────────┼────────────────┼────────────┤
│  3 │ Widget A         │ [50,100)       │       7.00 │
│  6 │ Widget B         │ [25,100)       │      12.00 │
└────┴──────────────────┴────────────────┴────────────┘
2 rows
```

Wait, that's wrong for Widget A. Let me check:

**Price tier for quantity 25 (corrected):**
```
dbsp> price_tiers where product_name = 'Widget A' and quantity_range contains 25
```
```
┌────┬──────────────────┬────────────────┬────────────┐
│ id │ product_name     │ quantity_range │ unit_price │
├────┼──────────────────┼────────────────┼────────────┤
│  2 │ Widget A         │ [10,50)        │       8.50 │
└────┴──────────────────┴────────────────┴────────────┘
1 row
```

### 4.5 Rooms with Bookings

**Rooms with their upcoming bookings:**
```
dbsp> rooms include room_bookings
```
```
┌────┬──────────────────────┬──────────┬───────────────────────────────────────────────────────────┐
│ id │ name                 │ capacity │ room_bookings                                             │
├────┼──────────────────────┼──────────┼───────────────────────────────────────────────────────────┤
│  1 │ Conference Room A    │       10 │ [{booked_by:"Alice",booking_period:"[2024-01-15,...)"},   │
│    │                      │          │  {booked_by:"Bob",...},{booked_by:"Frank",...}]          │
│  2 │ Conference Room B    │       20 │ [{booked_by:"Charlie",booking_period:"[2024-01-15,...)"} │
│  3 │ Board Room           │       30 │ [{booked_by:"David",booking_period:"[2024-01-20,...)"}]   │
│  4 │ Training Room        │       50 │ [{booked_by:"Eve",booking_period:"[2024-01-22,...)"}]     │
│  5 │ Small Meeting Room   │        4 │ []                                                        │
└────┴──────────────────────┴──────────┴───────────────────────────────────────────────────────────┘
5 rows
```

**Rooms with bookings that overlap next week:**
```
dbsp> rooms include room_bookings where booking_period overlaps [2024-01-22,2024-01-29)
```
```
┌────┬──────────────────────┬──────────┬───────────────────────────────────────────────────────────┐
│ id │ name                 │ capacity │ room_bookings                                             │
├────┼──────────────────────┼──────────┼───────────────────────────────────────────────────────────┤
│  1 │ Conference Room A    │       10 │ [{booked_by:"Frank",booking_period:"[2024-01-25,...)"}]   │
│  4 │ Training Room        │       50 │ [{booked_by:"Eve",booking_period:"[2024-01-22,...)"}]     │
└────┴──────────────────────┴──────────┴───────────────────────────────────────────────────────────┘
2 rows (with non-empty bookings)
```

---

## Chapter 5: E-Commerce Schema

**New concepts:** Multiple FK relations, complex hierarchies, window functions, advanced aggregates

### 5.1 Setup Database

```bash
# Reset database
docker exec pg-demo psql -U postgres -d demo -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Generate and apply DDL
pnpm dbsp generate ddl --schema ./examples/ecommerce.schema.ts -o /tmp/ecommerce.sql
docker exec -i pg-demo psql -U postgres -d demo < /tmp/ecommerce.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/ecommerce.seed.sql
```

### 5.2 Connect REPL

```bash
pnpm dbsp repl \
  --schema ./examples/ecommerce.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --exec
```

### 5.3 Explore Data

**Categories (hierarchical):**
```
dbsp> categories
```
```
┌────┬─────────────────────┬───────────┬────────────┐
│ id │ name                │ parent_id │ sort_order │
├────┼─────────────────────┼───────────┼────────────┤
│  1 │ Electronics         │ NULL      │          1 │
│  2 │ Phones              │         1 │          1 │
│  3 │ Laptops             │         1 │          2 │
│  4 │ Accessories         │         1 │          3 │
│  5 │ Clothing            │ NULL      │          2 │
│  6 │ Men's               │         5 │          1 │
│  7 │ Women's             │         5 │          2 │
└────┴─────────────────────┴───────────┴────────────┘
7 rows
```

**Products:**
```
dbsp> products where active = true limit 5
```
```
┌────┬──────────────┬─────────────────────────────┬─────────┬───────┬─────────────┐
│ id │ sku          │ name                        │ price   │ stock │ category_id │
├────┼──────────────┼─────────────────────────────┼─────────┼───────┼─────────────┤
│  1 │ PHONE-001    │ Smartphone X Pro            │  999.99 │    50 │           2 │
│  2 │ PHONE-002    │ Smartphone X Lite           │  499.99 │   100 │           2 │
│  3 │ LAPTOP-001   │ UltraBook Pro 15            │ 1499.99 │    30 │           3 │
│  4 │ LAPTOP-002   │ Gaming Laptop Z             │ 1999.99 │    20 │           3 │
│  5 │ ACC-001      │ Wireless Earbuds            │  149.99 │   200 │           4 │
└────┴──────────────┴─────────────────────────────┴─────────┴───────┴─────────────┘
5 rows
```

**Customers:**
```
dbsp> customers
```
```
┌────┬─────────────────────────┬────────────┬────────────┐
│ id │ email                   │ first_name │ last_name  │
├────┼─────────────────────────┼────────────┼────────────┤
│  1 │ alice@email.com         │ Alice      │ Johnson    │
│  2 │ bob@email.com           │ Bob        │ Smith      │
│  3 │ charlie@email.com       │ Charlie    │ Brown      │
│  4 │ diana@email.com         │ Diana      │ Williams   │
└────┴─────────────────────────┴────────────┴────────────┘
4 rows
```

**Orders:**
```
dbsp> orders
```
```
┌────┬───────────────┬─────────────┬──────────┬─────────┬─────────────────────┐
│ id │ order_number  │ customer_id │ status   │ total   │ created_at          │
├────┼───────────────┼─────────────┼──────────┼─────────┼─────────────────────┤
│  1 │ ORD-2024-001  │           1 │ delivered│ 1149.98 │ 2024-01-05 10:30:00 │
│  2 │ ORD-2024-002  │           1 │ shipped  │  499.99 │ 2024-01-10 14:00:00 │
│  3 │ ORD-2024-003  │           2 │ pending  │ 1999.99 │ 2024-01-12 09:15:00 │
│  4 │ ORD-2024-004  │           3 │ paid     │  299.98 │ 2024-01-14 16:45:00 │
│  5 │ ORD-2024-005  │           4 │ delivered│ 2499.98 │ 2024-01-15 11:00:00 │
│  6 │ ORD-2024-006  │           2 │ shipped  │  149.99 │ 2024-01-18 13:30:00 │
└────┴───────────────┴─────────────┴──────────┴─────────┴─────────────────────┘
6 rows
```

### 5.4 Complex Relations

**Categories with products:**
```
dbsp> categories include products where active = true
```
```
┌────┬─────────────────────┬───────────────────────────────────────────────────────────┐
│ id │ name                │ products                                                  │
├────┼─────────────────────┼───────────────────────────────────────────────────────────┤
│  1 │ Electronics         │ []                                                        │
│  2 │ Phones              │ [{sku:"PHONE-001",name:"Smartphone X Pro",...},           │
│    │                     │  {sku:"PHONE-002",name:"Smartphone X Lite",...}]          │
│  3 │ Laptops             │ [{sku:"LAPTOP-001",name:"UltraBook Pro 15",...},          │
│    │                     │  {sku:"LAPTOP-002",name:"Gaming Laptop Z",...}]           │
│  4 │ Accessories         │ [{sku:"ACC-001",name:"Wireless Earbuds",...}]             │
│  5 │ Clothing            │ []                                                        │
│  6 │ Men's               │ [{sku:"SHIRT-001",name:"Classic T-Shirt",...}]            │
│  7 │ Women's             │ [{sku:"DRESS-001",name:"Summer Dress",...}]               │
└────┴─────────────────────┴───────────────────────────────────────────────────────────┘
7 rows
```

**Products with variants:**
```
dbsp> products include variants limit 3
```
```
┌────┬──────────────┬─────────────────────────────┬───────────────────────────────────────────┐
│ id │ sku          │ name                        │ variants                                  │
├────┼──────────────┼─────────────────────────────┼───────────────────────────────────────────┤
│  1 │ PHONE-001    │ Smartphone X Pro            │ [{sku:"PHONE-001-BLK",name:"Black",...}, │
│    │              │                             │  {sku:"PHONE-001-WHT",name:"White",...}] │
│  2 │ PHONE-002    │ Smartphone X Lite           │ [{sku:"PHONE-002-BLU",name:"Blue",...}]  │
│  3 │ LAPTOP-001   │ UltraBook Pro 15            │ [{sku:"LAPTOP-001-SLV",name:"Silver",...},│
│    │              │                             │  {sku:"LAPTOP-001-GRY",name:"Space Gray"}]│
└────┴──────────────┴─────────────────────────────┴───────────────────────────────────────────┘
3 rows
```

**Customers with orders and items:**
```
dbsp> customers include orders include order_items
```
```
┌────┬─────────────┬─────────────────────────────────────────────────────────────────────┐
│ id │ first_name  │ orders                                                              │
├────┼─────────────┼─────────────────────────────────────────────────────────────────────┤
│  1 │ Alice       │ [{order_number:"ORD-2024-001",status:"delivered",                   │
│    │             │   order_items:[{product_id:1,quantity:1},{product_id:5,quantity:1}]},│
│    │             │  {order_number:"ORD-2024-002",status:"shipped",                     │
│    │             │   order_items:[{product_id:2,quantity:1}]}]                         │
│  2 │ Bob         │ [{order_number:"ORD-2024-003",status:"pending",...},                │
│    │             │  {order_number:"ORD-2024-006",status:"shipped",...}]                │
│  3 │ Charlie     │ [{order_number:"ORD-2024-004",status:"paid",...}]                   │
│  4 │ Diana       │ [{order_number:"ORD-2024-005",status:"delivered",...}]              │
└────┴─────────────┴─────────────────────────────────────────────────────────────────────┘
4 rows
```

### 5.5 Aggregates on E-Commerce Data

**Total revenue by status:**
```
dbsp> orders aggregate sum(total) by status
```
```
┌───────────┬───────────┐
│ status    │ sum_total │
├───────────┼───────────┤
│ delivered │   3649.96 │
│ shipped   │    649.98 │
│ pending   │   1999.99 │
│ paid      │    299.98 │
└───────────┴───────────┘
4 rows
```

**Orders per customer:**
```
dbsp> orders aggregate count by customer_id
```
```
┌─────────────┬───────┐
│ customer_id │ count │
├─────────────┼───────┤
│           1 │     2 │
│           2 │     2 │
│           3 │     1 │
│           4 │     1 │
└─────────────┴───────┘
4 rows
```

**Average order value:**
```
dbsp> orders aggregate avg(total)
```
```
┌───────────┐
│ avg_total │
├───────────┤
│   1099.98 │
└───────────┘
1 row
```

**Products in stock vs out of stock:**
```
dbsp> products aggregate count by active
```
```
┌────────┬───────┐
│ active │ count │
├────────┼───────┤
│ true   │     8 │
│ false  │     2 │
└────────┴───────┘
2 rows
```

### 5.6 Window Functions

**Products with rank by price in category:**
```
dbsp> products select *, rank() over (partition by category_id order by price desc) as price_rank
```
```
┌────┬──────────────┬─────────────────────────────┬─────────┬─────────────┬────────────┐
│ id │ sku          │ name                        │ price   │ category_id │ price_rank │
├────┼──────────────┼─────────────────────────────┼─────────┼─────────────┼────────────┤
│  4 │ LAPTOP-002   │ Gaming Laptop Z             │ 1999.99 │           3 │          1 │
│  3 │ LAPTOP-001   │ UltraBook Pro 15            │ 1499.99 │           3 │          2 │
│  1 │ PHONE-001    │ Smartphone X Pro            │  999.99 │           2 │          1 │
│  2 │ PHONE-002    │ Smartphone X Lite           │  499.99 │           2 │          2 │
│  5 │ ACC-001      │ Wireless Earbuds            │  149.99 │           4 │          1 │
└────┴──────────────┴─────────────────────────────┴─────────┴─────────────┴────────────┘
5 rows (showing Electronics only)
```

**Running total of orders:**
```
dbsp> orders select order_number, total, sum(total) over (order by created_at) as running_total
```
```
┌───────────────┬─────────┬───────────────┐
│ order_number  │ total   │ running_total │
├───────────────┼─────────┼───────────────┤
│ ORD-2024-001  │ 1149.98 │      1149.98  │
│ ORD-2024-002  │  499.99 │      1649.97  │
│ ORD-2024-003  │ 1999.99 │      3649.96  │
│ ORD-2024-004  │  299.98 │      3949.94  │
│ ORD-2024-005  │ 2499.98 │      6449.92  │
│ ORD-2024-006  │  149.99 │      6599.91  │
└───────────────┴─────────┴───────────────┘
6 rows
```

---

## Chapter 6: PIM/DAM Schema (Advanced)

**New concepts:** Soft deletes, complex M:N, multi-locale, advanced querying patterns

### 6.1 Setup Database

```bash
# Reset database
docker exec pg-demo psql -U postgres -d demo -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Generate and apply DDL
pnpm dbsp generate ddl --schema ./examples/pimdam.schema.ts -o /tmp/pimdam.sql
docker exec -i pg-demo psql -U postgres -d demo < /tmp/pimdam.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/pimdam.seed.sql
```

### 6.2 Connect REPL

```bash
pnpm dbsp repl \
  --schema ./examples/pimdam.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --exec
```

### 6.3 Explore the PIM/DAM Data

**Categories (hierarchical product taxonomy):**
```
dbsp> categories where active = true
```
```
┌────┬─────────────────────┬───────────┬──────────┬────────┐
│ id │ name                │ parent_id │ position │ active │
├────┼─────────────────────┼───────────┼──────────┼────────┤
│  1 │ Electronics         │ NULL      │        1 │ true   │
│  2 │ Smartphones         │         1 │        1 │ true   │
│  3 │ Tablets             │         1 │        2 │ true   │
│  4 │ Accessories         │         1 │        3 │ true   │
│  5 │ Furniture           │ NULL      │        2 │ true   │
│  6 │ Office              │         5 │        1 │ true   │
│  7 │ Living Room         │         5 │        2 │ true   │
└────┴─────────────────────┴───────────┴──────────┴────────┘
7 rows
```

**Products (with soft delete support):**
```
dbsp> products where deleted_at is null
```
```
┌────┬───────────────┬────────────────────────────────┬─────────────┬────────────────┐
│ id │ sku           │ title                          │ category_id │ brand          │
├────┼───────────────┼────────────────────────────────┼─────────────┼────────────────┤
│  1 │ SM-GALAXY-S24 │ Samsung Galaxy S24 Ultra       │           2 │ Samsung        │
│  2 │ IPHONE-15-PRO │ iPhone 15 Pro Max              │           2 │ Apple          │
│  3 │ IPAD-PRO-13   │ iPad Pro 13-inch M4            │           3 │ Apple          │
│  4 │ AIRPODS-PRO   │ AirPods Pro 2nd Gen            │           4 │ Apple          │
│  5 │ DESK-ERGO-01  │ ErgoDesk Pro Standing Desk     │           6 │ ErgoWorks      │
│  6 │ CHAIR-MESH-01 │ MeshComfort Executive Chair    │           6 │ OfficePro      │
│  7 │ SOFA-SECT-01  │ ModernLiving Sectional Sofa    │           7 │ HomeStyle      │
└────┴───────────────┴────────────────────────────────┴─────────────┴────────────────┘
7 rows
```

**Soft-deleted products (archived):**
```
dbsp> products where deleted_at is not null
```
```
┌────┬───────────────┬────────────────────────────────┬─────────────────────┐
│ id │ sku           │ title                          │ deleted_at          │
├────┼───────────────┼────────────────────────────────┼─────────────────────┤
│  8 │ OLD-PHONE-01  │ Discontinued Model X           │ 2024-01-15 00:00:00 │
│  9 │ OLD-TAB-01    │ Legacy Tablet 2020             │ 2024-01-10 00:00:00 │
└────┴───────────────┴────────────────────────────────┴─────────────────────┘
2 rows
```

**Images (DAM - Digital Asset Management):**
```
dbsp> images where status = 'approved'
```
```
┌────┬────────────────────────────────────┬────────────────┬──────────┬──────────┐
│ id │ filename                           │ content_type   │ size_kb  │ status   │
├────┼────────────────────────────────────┼────────────────┼──────────┼──────────┤
│  1 │ galaxy-s24-front.jpg               │ image/jpeg     │     2500 │ approved │
│  2 │ galaxy-s24-back.jpg                │ image/jpeg     │     2300 │ approved │
│  3 │ iphone-15-hero.jpg                 │ image/jpeg     │     3200 │ approved │
│  4 │ iphone-15-colors.jpg               │ image/jpeg     │     2800 │ approved │
│  5 │ ipad-pro-studio.jpg                │ image/jpeg     │     4500 │ approved │
│  6 │ airpods-case.jpg                   │ image/jpeg     │     1200 │ approved │
│  7 │ ergo-desk-office.jpg               │ image/jpeg     │     3800 │ approved │
└────┴────────────────────────────────────┴────────────────┴──────────┴──────────┘
7 rows
```

### 6.4 M:N Product-Image Relationships

**Products with their images:**
```
dbsp> products where deleted_at is null include images where status = 'approved'
```
```
┌────┬───────────────┬────────────────────────────────┬───────────────────────────────────────────────┐
│ id │ sku           │ title                          │ images                                        │
├────┼───────────────┼────────────────────────────────┼───────────────────────────────────────────────┤
│  1 │ SM-GALAXY-S24 │ Samsung Galaxy S24 Ultra       │ [{filename:"galaxy-s24-front.jpg",locale:"en"},│
│    │               │                                │  {filename:"galaxy-s24-back.jpg",locale:"en"}] │
│  2 │ IPHONE-15-PRO │ iPhone 15 Pro Max              │ [{filename:"iphone-15-hero.jpg",...},         │
│    │               │                                │  {filename:"iphone-15-colors.jpg",...}]       │
│  3 │ IPAD-PRO-13   │ iPad Pro 13-inch M4            │ [{filename:"ipad-pro-studio.jpg",...}]        │
│  4 │ AIRPODS-PRO   │ AirPods Pro 2nd Gen            │ [{filename:"airpods-case.jpg",...}]           │
│  5 │ DESK-ERGO-01  │ ErgoDesk Pro Standing Desk     │ [{filename:"ergo-desk-office.jpg",...}]       │
└────┴───────────────┴────────────────────────────────┴───────────────────────────────────────────────┘
5 rows (with images)
```

**Images by locale:**
```
dbsp> product_images where locale = 'en' include product include image
```
```
┌────────────┬──────────┬────────┬──────────────────────────────────────────────────────────┐
│ product_id │ image_id │ locale │ product                        │ image                   │
├────────────┼──────────┼────────┼────────────────────────────────┼─────────────────────────┤
│          1 │        1 │ en     │ {title:"Samsung Galaxy..."}    │ {filename:"galaxy..."}  │
│          1 │        2 │ en     │ {title:"Samsung Galaxy..."}    │ {filename:"galaxy..."}  │
│          2 │        3 │ en     │ {title:"iPhone 15 Pro..."}     │ {filename:"iphone..."}  │
└────────────┴──────────┴────────┴────────────────────────────────┴─────────────────────────┘
```

### 6.5 Advanced Filtering Patterns

**Active products in a specific category tree:**
```
dbsp> products where active = true and deleted_at is null and category_id = 2 include category
```
```
┌────┬───────────────┬────────────────────────────────┬────────────────────────────────┐
│ id │ sku           │ title                          │ category                       │
├────┼───────────────┼────────────────────────────────┼────────────────────────────────┤
│  1 │ SM-GALAXY-S24 │ Samsung Galaxy S24 Ultra       │ {name:"Smartphones",...}       │
│  2 │ IPHONE-15-PRO │ iPhone 15 Pro Max              │ {name:"Smartphones",...}       │
└────┴───────────────┴────────────────────────────────┴────────────────────────────────┘
2 rows
```

**Products by brand with image count:**
```
dbsp> products where deleted_at is null aggregate count by brand
```
```
┌────────────┬───────┐
│ brand      │ count │
├────────────┼───────┤
│ Apple      │     3 │
│ Samsung    │     1 │
│ ErgoWorks  │     1 │
│ OfficePro  │     1 │
│ HomeStyle  │     1 │
└────────────┴───────┘
5 rows
```

### 6.6 Recursive Category Queries

**Get full category hierarchy:**
```
dbsp> categories recursive include children maxDepth 3
```
```
┌────┬─────────────────────┬───────────┬─────────────────────────────────────────────────────────┐
│ id │ name                │ parent_id │ children                                                │
├────┼─────────────────────┼───────────┼─────────────────────────────────────────────────────────┤
│  1 │ Electronics         │ NULL      │ [{name:"Smartphones",children:[]},                      │
│    │                     │           │  {name:"Tablets",children:[]},                          │
│    │                     │           │  {name:"Accessories",children:[]}]                      │
│  5 │ Furniture           │ NULL      │ [{name:"Office",children:[]},                           │
│    │                     │           │  {name:"Living Room",children:[]}]                      │
└────┴─────────────────────┴───────────┴─────────────────────────────────────────────────────────┘
2 rows (root categories with full tree)
```

---

## Chapter 7: CLI Commands Reference

### Generate Commands

```bash
# Generate DDL (create tables)
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts

# Generate DDL to file
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts -o schema.sql

# Generate DDL for specific dialect
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts --dialect mysql

# Generate Kysely types
pnpm dbsp generate kysely --schema ./examples/minimal.schema.ts -o types.ts

# Generate schema manifest (JSON)
pnpm dbsp generate manifest --schema ./examples/minimal.schema.ts -o manifest.json
```

### REPL Commands

```bash
# Start in compile mode (show SQL only)
pnpm dbsp repl --schema ./examples/minimal.schema.ts

# Start in execute mode (run queries)
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://... --exec

# Start with specific dialect
pnpm dbsp repl --schema ./examples/minimal.schema.ts --dialect mysql
```

### REPL Built-in Commands

| Command | Description |
|---------|-------------|
| `.tables` | List all tables |
| `.schema <table>` | Show table columns |
| `.relations <table>` | Show table relations |
| `.exec` | Enable execution mode |
| `.compile` | Disable execution mode (show SQL only) |
| `.dump` | Show last query plan |
| `.sql` | Show last SQL only |
| `.help` | Show help |
| `.exit` | Exit REPL |

### Batch Execution

```bash
# Run queries from file
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://... --exec < queries.dbsp

# Run with assertions
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://... --exec < test.assert.dbsp
```

---

## Cleanup

When done experimenting:

```bash
# Stop and remove PostgreSQL container
docker stop pg-demo
docker rm pg-demo
```

---

## Next Steps

- Explore the [API Reference](../docs/API.md) for programmatic usage
- Check [Examples](./README.md) for more complex scenarios
- Read about [Multi-tenant Support](../docs/MULTI_TENANT.md) for schema isolation
