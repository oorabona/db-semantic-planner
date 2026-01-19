-- Minimal Schema DDL
-- Generated from: pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts
--
-- Usage:
--   psql -d your_db -f examples/minimal.ddl.sql

create table "users" ("id" integer not null primary key, "name" varchar(255) not null, "email" varchar(255) not null);

create table "posts" ("id" integer not null primary key, "title" varchar(255) not null, "content" text, "user_id" integer not null);

alter table "posts" add constraint "fk_posts_user_id" foreign key ("user_id") references "users" ("id");
