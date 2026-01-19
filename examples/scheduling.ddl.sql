create table "rooms" ("id" integer not null primary key, "name" varchar(255) not null, "capacity" integer not null, "floor" integer not null);

create table "room_bookings" ("id" integer not null primary key, "room_id" integer not null, "booked_by" varchar(255) not null, "booking_period" daterange not null, "purpose" varchar(255));

create table "events" ("id" integer not null primary key, "title" varchar(255) not null, "room_id" integer not null, "time_slot" tstzrange not null, "organizer" varchar(255) not null, "max_attendees" integer);

create table "price_tiers" ("id" integer not null primary key, "product_name" varchar(255) not null, "quantity_range" int4range not null, "unit_price" decimal not null);

alter table "room_bookings" add constraint "fk_room_bookings_room_id" foreign key ("room_id") references "rooms" ("id") on delete cascade;

alter table "events" add constraint "fk_events_room_id" foreign key ("room_id") references "rooms" ("id") on delete cascade;

create index "idx_room_bookings_room_id" on "room_bookings" ("room_id");

create index "idx_events_room_id" on "events" ("room_id");

create index "idx_price_tiers_product_name" on "price_tiers" ("product_name");