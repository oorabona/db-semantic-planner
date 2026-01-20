drop table if exists "users" cascade;

drop table if exists "posts" cascade;



create table "users" ("id" serial primary key, "name" varchar(255) not null, "email" varchar(255) not null unique);

create table "posts" ("id" serial primary key, "title" varchar(255) not null, "content" text, "user_id" integer not null);

alter table "posts" add constraint "fk_posts_user_id" foreign key ("user_id") references "users" ("id") on delete cascade;

create index "idx_users_name" on "users" ("name");

create index "idx_posts_user_id" on "posts" ("user_id");
