create table "categories" ("id" integer not null primary key, "name" varchar(255) not null, "slug" varchar(255) not null, "description" text, "parent_id" integer, "position" integer default '0' not null, "active" boolean default 'true' not null, "created_at" timestamptz default now() not null);

create table "products" ("id" integer not null primary key, "sku" varchar(255) not null unique, "title" varchar(255) not null, "description" text, "category_id" integer not null, "brand" varchar(255), "active" boolean default 'true' not null, "created_at" timestamptz default now() not null, "updated_at" timestamptz, "deleted_at" timestamptz);

create table "assets" ("id" integer not null primary key, "kind" varchar(255) not null, "filename" varchar(255) not null, "sha256" varchar(255) not null, "mime" varchar(255) not null, "width" integer, "height" integer, "size_bytes" integer not null, "storage_key" varchar(255) not null, "alt_text" varchar(255), "expires_at" timestamptz, "created_at" timestamptz default now() not null);

create table "product_images" ("id" integer not null primary key, "product_id" integer not null, "asset_id" integer not null, "locale" varchar(255) not null, "status" varchar(255) default '''pending''' not null, "is_main" boolean default 'false' not null, "position" integer default '0' not null, "rejected_reason" varchar(255), "approved_by" varchar(255), "approved_at" timestamptz, "created_at" timestamptz default now() not null, "deleted_at" timestamptz);

create table "variants" ("id" integer not null primary key, "product_id" integer not null, "sku" varchar(255) not null unique, "name" varchar(255) not null, "price_cents" integer not null, "compare_at_price_cents" integer, "cost_cents" integer, "stock" integer default '0' not null, "weight_grams" integer, "barcode" varchar(255), "active" boolean default 'true' not null, "created_at" timestamptz default now() not null);

alter table "categories" add constraint "fk_categories_parent_id" foreign key ("parent_id") references "categories" ("id") on delete set null;

alter table "products" add constraint "fk_products_category_id" foreign key ("category_id") references "categories" ("id");

alter table "product_images" add constraint "fk_product_images_product_id" foreign key ("product_id") references "products" ("id") on delete cascade;

alter table "product_images" add constraint "fk_product_images_asset_id" foreign key ("asset_id") references "assets" ("id");

alter table "variants" add constraint "fk_variants_product_id" foreign key ("product_id") references "products" ("id") on delete cascade;

create index "idx_categories_slug" on "categories" ("slug");

create index "idx_categories_parent_id" on "categories" ("parent_id");

create index "idx_categories_active" on "categories" ("active");

create index "idx_products_category_id" on "products" ("category_id");

create index "idx_products_active" on "products" ("active");

create index "idx_assets_kind" on "assets" ("kind");

create index "idx_assets_sha256" on "assets" ("sha256");

create index "idx_product_images_product_id" on "product_images" ("product_id");

create index "idx_product_images_locale" on "product_images" ("locale");

create index "idx_product_images_status" on "product_images" ("status");

create index "idx_variants_product_id" on "variants" ("product_id");