create table "authors" ("id" serial primary key, "name" varchar(255) not null, "email" varchar(255) not null unique, "active" boolean default 'true' not null);

create table "categories" ("id" serial primary key, "name" varchar(255) not null, "parent_id" integer);

create table "posts" ("id" serial primary key, "title" varchar(255) not null, "content" text not null, "author_id" integer not null, "category_id" integer, "published" boolean default 'false' not null, "featured" boolean default 'false' not null, "view_count" integer default '0' not null, "created_at" timestamptz default now() not null);

create table "comments" ("id" serial primary key, "post_id" integer not null, "author_name" varchar(255) not null, "content" text not null, "approved" boolean default 'false' not null, "created_at" timestamptz default now() not null);

create table "tags" ("id" serial primary key, "name" varchar(255) not null, "slug" varchar(255) not null unique);

create table "post_tags" ("post_id" integer not null, "tag_id" integer not null, constraint "pk_post_tags" primary key ("post_id", "tag_id"));

alter table "categories" add constraint "fk_categories_parent_id" foreign key ("parent_id") references "categories" ("id");

alter table "posts" add constraint "fk_posts_author_id" foreign key ("author_id") references "authors" ("id");

alter table "posts" add constraint "fk_posts_category_id" foreign key ("category_id") references "categories" ("id");

alter table "comments" add constraint "fk_comments_post_id" foreign key ("post_id") references "posts" ("id");

alter table "post_tags" add constraint "fk_post_tags_post_id" foreign key ("post_id") references "posts" ("id");

alter table "post_tags" add constraint "fk_post_tags_tag_id" foreign key ("tag_id") references "tags" ("id");

create index "idx_categories_parent_id" on "categories" ("parent_id");

create index "idx_posts_author_id" on "posts" ("author_id");

create index "idx_posts_category_id" on "posts" ("category_id");

create index "idx_posts_published" on "posts" ("published");

create index "idx_posts_featured" on "posts" ("featured");

create index "idx_comments_post_id" on "comments" ("post_id");

create index "idx_comments_approved" on "comments" ("approved");

create index "idx_post_tags_post_id" on "post_tags" ("post_id");

create index "idx_post_tags_tag_id" on "post_tags" ("tag_id");