create table "authors" ("id" integer not null primary key, "name" varchar(255) not null, "email" varchar(255) not null unique, "bio" text, "created_at" timestamptz default now() not null);

create table "posts" ("id" integer not null primary key, "title" varchar(255) not null, "slug" varchar(255) not null unique, "content" text, "published" boolean default 'false' not null, "author_id" integer not null, "created_at" timestamptz default now() not null, "updated_at" timestamptz);

create table "comments" ("id" integer not null primary key, "post_id" integer not null, "author_name" varchar(255) not null, "author_email" varchar(255), "content" text not null, "approved" boolean default 'false' not null, "created_at" timestamptz default now() not null);

create table "tags" ("id" integer not null primary key, "name" varchar(255) not null unique, "slug" varchar(255) not null unique);

create table "post_tags" ("post_id" integer not null, "tag_id" integer not null, constraint "pk_post_tags" primary key ("post_id", "tag_id"));

alter table "posts" add constraint "fk_posts_author_id" foreign key ("author_id") references "authors" ("id") on delete cascade;

alter table "comments" add constraint "fk_comments_post_id" foreign key ("post_id") references "posts" ("id") on delete cascade;

alter table "post_tags" add constraint "fk_post_tags_post_id" foreign key ("post_id") references "posts" ("id") on delete cascade;

alter table "post_tags" add constraint "fk_post_tags_tag_id" foreign key ("tag_id") references "tags" ("id") on delete cascade;

create index "idx_posts_published" on "posts" ("published");

create index "idx_posts_author_id" on "posts" ("author_id");

create index "idx_comments_post_id" on "comments" ("post_id");

create index "idx_comments_approved" on "comments" ("approved");

create index "idx_post_tags_tag_id" on "post_tags" ("tag_id");