create table "categories" ("id" integer not null primary key, "name" varchar(255) not null, "slug" varchar(255) not null unique, "parent_id" integer, "sort_order" integer default '0' not null);

create table "products" ("id" integer not null primary key, "sku" varchar(255) not null unique, "name" varchar(255) not null, "description" text, "price" decimal not null, "stock" integer default '0' not null, "category_id" integer not null, "active" boolean default 'true' not null, "created_at" timestamptz default now() not null);

create table "variants" ("id" integer not null primary key, "product_id" integer not null, "sku" varchar(255) not null unique, "name" varchar(255) not null, "price_modifier" decimal default '0' not null, "stock" integer default '0' not null);

create table "customers" ("id" integer not null primary key, "email" varchar(255) not null unique, "first_name" varchar(255) not null, "last_name" varchar(255) not null, "phone" varchar(255), "created_at" timestamptz default now() not null);

create table "addresses" ("id" integer not null primary key, "customer_id" integer not null, "type" varchar(255) not null, "street" varchar(255) not null, "city" varchar(255) not null, "postal_code" varchar(255) not null, "country" varchar(255) not null, "is_default" boolean default 'false' not null);

create table "orders" ("id" integer not null primary key, "order_number" varchar(255) not null unique, "customer_id" integer not null, "status" varchar(255) default '''pending''' not null, "total" decimal not null, "shipping_address_id" integer not null, "billing_address_id" integer not null, "created_at" timestamptz default now() not null, "updated_at" timestamptz);

create table "order_items" ("id" integer not null primary key, "order_id" integer not null, "product_id" integer not null, "variant_id" integer, "quantity" integer not null, "unit_price" decimal not null, "total_price" decimal not null);

alter table "categories" add constraint "fk_categories_parent_id" foreign key ("parent_id") references "categories" ("id") on delete set null;

alter table "products" add constraint "fk_products_category_id" foreign key ("category_id") references "categories" ("id") on delete restrict;

alter table "variants" add constraint "fk_variants_product_id" foreign key ("product_id") references "products" ("id") on delete cascade;

alter table "addresses" add constraint "fk_addresses_customer_id" foreign key ("customer_id") references "customers" ("id") on delete cascade;

alter table "orders" add constraint "fk_orders_customer_id" foreign key ("customer_id") references "customers" ("id") on delete restrict;

alter table "orders" add constraint "fk_orders_shipping_address_id" foreign key ("shipping_address_id") references "addresses" ("id");

alter table "orders" add constraint "fk_orders_billing_address_id" foreign key ("billing_address_id") references "addresses" ("id");

alter table "order_items" add constraint "fk_order_items_order_id" foreign key ("order_id") references "orders" ("id") on delete cascade;

alter table "order_items" add constraint "fk_order_items_product_id" foreign key ("product_id") references "products" ("id") on delete restrict;

alter table "order_items" add constraint "fk_order_items_variant_id" foreign key ("variant_id") references "variants" ("id") on delete set null;

create index "idx_categories_parent_id" on "categories" ("parent_id");

create index "idx_products_category_id" on "products" ("category_id");

create index "idx_products_active" on "products" ("active");

create index "idx_variants_product_id" on "variants" ("product_id");

create index "idx_addresses_customer_id" on "addresses" ("customer_id");

create index "idx_orders_customer_id" on "orders" ("customer_id");

create index "idx_orders_status" on "orders" ("status");

create index "idx_order_items_order_id" on "order_items" ("order_id");

create index "idx_order_items_product_id" on "order_items" ("product_id");