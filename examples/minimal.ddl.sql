create table "users" ("id" integer not null primary key, "name" varchar(255) not null, "email" varchar(255) not null unique);

create table "posts" ("id" integer not null primary key, "title" varchar(255) not null, "content" text, "user_id" integer not null);

alter table "posts" add constraint "fk_posts_user_id" foreign key ("user_id") references "users" ("id") on delete cascade;

create index "idx_users_name" on "users" ("name");