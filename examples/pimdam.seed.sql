-- PIM/DAM Seed Data
--
-- Realistic test data for Product Information Management / Digital Asset Management.
-- Run after DDL: psql -d your_db -f examples/pimdam.seed.sql
--
-- Or via REPL: .import examples/pimdam.seed.sql

-- Clean existing data
TRUNCATE variants, product_images, assets, products, categories RESTART IDENTITY CASCADE;

-- ============================================================================
-- CATEGORIES (12 rows)
-- Hierarchical taxonomy: Electronics > Phones > Smartphones
-- ============================================================================

INSERT INTO categories (id, name, slug, description, parent_id, position, active, created_at) VALUES
-- Root categories
(1,  'Electronics',       'electronics',       'Electronic devices and accessories', NULL, 0, TRUE,  '2024-01-01 08:00:00+00'),
(2,  'Clothing',          'clothing',          'Apparel and fashion items',          NULL, 1, TRUE,  '2024-01-01 08:00:00+00'),
(3,  'Home & Garden',     'home-garden',       'Home improvement and gardening',     NULL, 2, TRUE,  '2024-01-01 08:00:00+00'),

-- Electronics sub-categories
(4,  'Phones',            'phones',            'Smartphones and accessories',        1,    0, TRUE,  '2024-01-01 08:01:00+00'),
(5,  'Computers',         'computers',         'Laptops, desktops, tablets',         1,    1, TRUE,  '2024-01-01 08:01:00+00'),
(6,  'Audio',             'audio',             'Headphones, speakers, earbuds',      1,    2, TRUE,  '2024-01-01 08:01:00+00'),

-- Phones sub-categories
(7,  'Smartphones',       'smartphones',       'Android and iOS smartphones',        4,    0, TRUE,  '2024-01-01 08:02:00+00'),
(8,  'Phone Accessories', 'phone-accessories', 'Cases, chargers, screen protectors', 4,    1, TRUE,  '2024-01-01 08:02:00+00'),

-- Clothing sub-categories
(9,  'Men',               'men',               'Mens clothing',                      2,    0, TRUE,  '2024-01-01 08:01:00+00'),
(10, 'Women',             'women',             'Womens clothing',                    2,    1, TRUE,  '2024-01-01 08:01:00+00'),
(11, 'Kids',              'kids',              'Childrens clothing',                 2,    2, FALSE, '2024-01-01 08:01:00+00'), -- inactive

-- Archived category
(12, 'Legacy Products',   'legacy',            'Discontinued items',                 NULL, 99, FALSE, '2024-01-01 08:00:00+00');

SELECT setval('categories_id_seq', 12);

-- ============================================================================
-- PRODUCTS (15 rows)
-- Mix of active, soft-deleted, and various brands
-- ============================================================================

INSERT INTO products (id, sku, title, description, category_id, brand, active, deleted_at, created_at) VALUES
-- Smartphones (category 7)
(1,  'PHONE-IP15-256',   'iPhone 15 Pro 256GB',         'Latest Apple flagship with A17 chip',        7, 'Apple',   TRUE,  NULL,         '2024-01-02 10:00:00+00'),
(2,  'PHONE-IP15-512',   'iPhone 15 Pro 512GB',         'Apple flagship with more storage',           7, 'Apple',   TRUE,  NULL,         '2024-01-02 10:00:00+00'),
(3,  'PHONE-S24-256',    'Samsung Galaxy S24 256GB',    'Samsung flagship with AI features',          7, 'Samsung', TRUE,  NULL,         '2024-01-02 10:00:00+00'),
(4,  'PHONE-PX8-128',    'Google Pixel 8 128GB',        'Google phone with best camera AI',           7, 'Google',  TRUE,  NULL,         '2024-01-02 10:00:00+00'),
(5,  'PHONE-OLD-001',    'iPhone 12 64GB',              'Previous generation iPhone',                 7, 'Apple',   FALSE, '2024-06-01', '2024-01-02 10:00:00+00'),

-- Phone Accessories (category 8)
(6,  'ACC-CASE-IP15',    'iPhone 15 Silicone Case',     'Official Apple silicone case',               8, 'Apple',   TRUE,  NULL,         '2024-01-03 10:00:00+00'),
(7,  'ACC-CHRG-USB-C',   'USB-C Fast Charger 65W',      'Universal fast charger for all devices',     8, 'Anker',   TRUE,  NULL,         '2024-01-03 10:00:00+00'),
(8,  'ACC-SCRN-IP15',    'iPhone 15 Screen Protector',  'Tempered glass screen protector',            8, 'Belkin',  TRUE,  NULL,         '2024-01-03 10:00:00+00'),

-- Audio (category 6)
(9,  'AUDIO-APP-MAX',    'AirPods Max',                 'Over-ear headphones with ANC',               6, 'Apple',   TRUE,  NULL,         '2024-01-04 10:00:00+00'),
(10, 'AUDIO-APP-PRO2',   'AirPods Pro 2',               'Wireless earbuds with ANC',                  6, 'Apple',   TRUE,  NULL,         '2024-01-04 10:00:00+00'),
(11, 'AUDIO-SONY-XM5',   'Sony WH-1000XM5',             'Premium noise cancelling headphones',        6, 'Sony',    TRUE,  NULL,         '2024-01-04 10:00:00+00'),

-- Computers (category 5)
(12, 'COMP-MBP-14',      'MacBook Pro 14" M3',          'Professional laptop with M3 chip',           5, 'Apple',   TRUE,  NULL,         '2024-01-05 10:00:00+00'),
(13, 'COMP-MBP-16',      'MacBook Pro 16" M3 Max',      'Ultimate performance laptop',                5, 'Apple',   TRUE,  NULL,         '2024-01-05 10:00:00+00'),

-- Clothing - Men (category 9)
(14, 'CLO-MEN-TSHIRT',   'Basic Cotton T-Shirt',        'Comfortable everyday t-shirt',               9, 'Uniqlo',  TRUE,  NULL,         '2024-01-06 10:00:00+00'),

-- Soft-deleted product
(15, 'OLD-DISCONTINUED', 'Discontinued Widget',         'This product was removed',                   12, NULL,     FALSE, '2024-01-15', '2023-06-01 10:00:00+00');

SELECT setval('products_id_seq', 15);

-- ============================================================================
-- ASSETS (20 rows)
-- Images, videos, and documents for products
-- ============================================================================

INSERT INTO assets (id, kind, filename, sha256, mime, width, height, size_bytes, storage_key, alt_text, created_at) VALUES
-- iPhone 15 Pro images
(1,  'image', 'iphone15-front.jpg',      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', 'image/jpeg', 1200, 1600, 245000, 'products/iphone15/front.jpg', 'iPhone 15 Pro front view', '2024-01-02 12:00:00+00'),
(2,  'image', 'iphone15-back.jpg',       'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3', 'image/jpeg', 1200, 1600, 238000, 'products/iphone15/back.jpg', 'iPhone 15 Pro back view', '2024-01-02 12:00:00+00'),
(3,  'image', 'iphone15-side.jpg',       'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', 'image/jpeg', 800,  1200, 156000, 'products/iphone15/side.jpg', 'iPhone 15 Pro side view', '2024-01-02 12:00:00+00'),

-- Samsung Galaxy S24 images
(4,  'image', 'galaxy-s24-front.jpg',    'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5', 'image/jpeg', 1200, 1600, 267000, 'products/galaxy-s24/front.jpg', 'Galaxy S24 front view', '2024-01-02 12:00:00+00'),
(5,  'image', 'galaxy-s24-back.jpg',     'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6', 'image/jpeg', 1200, 1600, 254000, 'products/galaxy-s24/back.jpg', 'Galaxy S24 back view', '2024-01-02 12:00:00+00'),

-- Pixel 8 images
(6,  'image', 'pixel8-front.jpg',        'f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1', 'image/jpeg', 1200, 1600, 234000, 'products/pixel8/front.jpg', 'Pixel 8 front view', '2024-01-02 12:00:00+00'),
(7,  'image', 'pixel8-camera.jpg',       'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', 'image/jpeg', 1600, 1200, 289000, 'products/pixel8/camera.jpg', 'Pixel 8 camera detail', '2024-01-02 12:00:00+00'),

-- Accessories images
(8,  'image', 'case-ip15-blue.jpg',      'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3', 'image/jpeg', 800,  800,  98000,  'products/case-ip15/blue.jpg', 'iPhone 15 case in blue', '2024-01-03 12:00:00+00'),
(9,  'image', 'case-ip15-black.jpg',     'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', 'image/jpeg', 800,  800,  95000,  'products/case-ip15/black.jpg', 'iPhone 15 case in black', '2024-01-03 12:00:00+00'),
(10, 'image', 'charger-65w.jpg',         'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5', 'image/jpeg', 600,  600,  78000,  'products/charger/65w.jpg', 'USB-C 65W charger', '2024-01-03 12:00:00+00'),

-- Audio images
(11, 'image', 'airpods-max-silver.jpg',  'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6', 'image/jpeg', 1000, 1000, 187000, 'products/airpods-max/silver.jpg', 'AirPods Max in silver', '2024-01-04 12:00:00+00'),
(12, 'image', 'airpods-pro2.jpg',        'f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1', 'image/jpeg', 800,  800,  134000, 'products/airpods-pro2/main.jpg', 'AirPods Pro 2 with case', '2024-01-04 12:00:00+00'),
(13, 'image', 'sony-xm5-black.jpg',      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', 'image/jpeg', 1200, 1000, 198000, 'products/sony-xm5/black.jpg', 'Sony WH-1000XM5 in black', '2024-01-04 12:00:00+00'),

-- MacBook images
(14, 'image', 'mbp14-open.jpg',          'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3', 'image/jpeg', 1600, 1000, 312000, 'products/mbp14/open.jpg', 'MacBook Pro 14 open', '2024-01-05 12:00:00+00'),
(15, 'image', 'mbp14-closed.jpg',        'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', 'image/jpeg', 1200, 800,  245000, 'products/mbp14/closed.jpg', 'MacBook Pro 14 closed', '2024-01-05 12:00:00+00'),
(16, 'image', 'mbp16-keyboard.jpg',      'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5', 'image/jpeg', 1600, 900,  287000, 'products/mbp16/keyboard.jpg', 'MacBook Pro 16 keyboard', '2024-01-05 12:00:00+00'),

-- Video and document assets
(17, 'video',    'iphone15-demo.mp4',    'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6', 'video/mp4',  1920, 1080, 45000000, 'products/iphone15/demo.mp4', 'iPhone 15 demo video', '2024-01-02 12:00:00+00'),
(18, 'document', 'iphone15-specs.pdf',   'f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1', 'application/pdf', NULL, NULL, 1200000, 'products/iphone15/specs.pdf', 'iPhone 15 specifications', '2024-01-02 12:00:00+00'),

-- Clothing images
(19, 'image', 'tshirt-white.jpg',        'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', 'image/jpeg', 800,  1000, 134000, 'products/tshirt/white.jpg', 'White cotton t-shirt', '2024-01-06 12:00:00+00'),
(20, 'image', 'tshirt-black.jpg',        'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3', 'image/jpeg', 800,  1000, 128000, 'products/tshirt/black.jpg', 'Black cotton t-shirt', '2024-01-06 12:00:00+00');

SELECT setval('assets_id_seq', 20);

-- ============================================================================
-- PRODUCT_IMAGES (25 rows)
-- Localized images with approval workflow
-- ============================================================================

INSERT INTO product_images (id, product_id, asset_id, locale, status, is_main, position, approved_by, approved_at, rejected_reason, created_at) VALUES
-- iPhone 15 Pro 256GB - EN (approved)
(1,  1, 1, 'en', 'approved', TRUE,  0, 'john.reviewer', '2024-01-10', NULL, '2024-01-08 14:00:00+00'),
(2,  1, 2, 'en', 'approved', FALSE, 1, 'john.reviewer', '2024-01-10', NULL, '2024-01-08 14:00:00+00'),
(3,  1, 3, 'en', 'approved', FALSE, 2, 'john.reviewer', '2024-01-10', NULL, '2024-01-08 14:00:00+00'),

-- iPhone 15 Pro 256GB - FR (pending + approved mix)
(4,  1, 1, 'fr', 'approved', TRUE,  0, 'marie.reviewer', '2024-01-12', NULL, '2024-01-09 14:00:00+00'),
(5,  1, 2, 'fr', 'pending',  FALSE, 1, NULL, NULL, NULL, '2024-01-09 14:00:00+00'),

-- iPhone 15 Pro 256GB - DE (rejected)
(6,  1, 1, 'de', 'rejected', FALSE, 0, NULL, NULL, 'Image quality too low for German market', '2024-01-09 15:00:00+00'),

-- Samsung Galaxy S24 - EN (approved)
(7,  3, 4, 'en', 'approved', TRUE,  0, 'john.reviewer', '2024-01-15', NULL, '2024-01-13 14:00:00+00'),
(8,  3, 5, 'en', 'approved', FALSE, 1, 'john.reviewer', '2024-01-15', NULL, '2024-01-13 14:00:00+00'),

-- Samsung Galaxy S24 - FR (approved)
(9,  3, 4, 'fr', 'approved', TRUE,  0, 'marie.reviewer', '2024-01-16', NULL, '2024-01-14 14:00:00+00'),

-- Google Pixel 8 - EN (approved)
(10, 4, 6, 'en', 'approved', TRUE,  0, 'john.reviewer', '2024-01-18', NULL, '2024-01-16 14:00:00+00'),
(11, 4, 7, 'en', 'approved', FALSE, 1, 'john.reviewer', '2024-01-18', NULL, '2024-01-16 14:00:00+00'),

-- iPhone Case - EN (approved)
(12, 6, 8, 'en', 'approved', TRUE,  0, 'sarah.reviewer', '2024-01-20', NULL, '2024-01-18 14:00:00+00'),
(13, 6, 9, 'en', 'approved', FALSE, 1, 'sarah.reviewer', '2024-01-20', NULL, '2024-01-18 14:00:00+00'),

-- Charger - EN (pending)
(14, 7, 10, 'en', 'pending', TRUE, 0, NULL, NULL, NULL, '2024-01-19 14:00:00+00'),

-- AirPods Max - EN + FR (approved)
(15, 9,  11, 'en', 'approved', TRUE, 0, 'john.reviewer', '2024-01-22', NULL, '2024-01-20 14:00:00+00'),
(16, 9,  11, 'fr', 'approved', TRUE, 0, 'marie.reviewer', '2024-01-23', NULL, '2024-01-21 14:00:00+00'),

-- AirPods Pro 2 - EN (approved)
(17, 10, 12, 'en', 'approved', TRUE, 0, 'sarah.reviewer', '2024-01-24', NULL, '2024-01-22 14:00:00+00'),

-- Sony XM5 - EN (approved)
(18, 11, 13, 'en', 'approved', TRUE, 0, 'john.reviewer', '2024-01-25', NULL, '2024-01-23 14:00:00+00'),

-- MacBook Pro 14 - EN (approved)
(19, 12, 14, 'en', 'approved', TRUE,  0, 'john.reviewer', '2024-01-28', NULL, '2024-01-26 14:00:00+00'),
(20, 12, 15, 'en', 'approved', FALSE, 1, 'john.reviewer', '2024-01-28', NULL, '2024-01-26 14:00:00+00'),

-- MacBook Pro 16 - EN (approved)
(21, 13, 14, 'en', 'approved', TRUE,  0, 'sarah.reviewer', '2024-01-29', NULL, '2024-01-27 14:00:00+00'),
(22, 13, 16, 'en', 'approved', FALSE, 1, 'sarah.reviewer', '2024-01-29', NULL, '2024-01-27 14:00:00+00'),

-- T-Shirt - EN (approved), FR (pending)
(23, 14, 19, 'en', 'approved', TRUE, 0, 'sarah.reviewer', '2024-02-01', NULL, '2024-01-30 14:00:00+00'),
(24, 14, 20, 'en', 'approved', FALSE, 1, 'sarah.reviewer', '2024-02-01', NULL, '2024-01-30 14:00:00+00'),
(25, 14, 19, 'fr', 'pending',  TRUE, 0, NULL, NULL, NULL, '2024-01-31 14:00:00+00');

SELECT setval('product_images_id_seq', 25);

-- ============================================================================
-- VARIANTS (22 rows)
-- Product variations with pricing and stock
-- ============================================================================

INSERT INTO variants (id, product_id, sku, name, price_cents, compare_at_price_cents, cost_cents, stock, weight_grams, barcode, created_at) VALUES
-- iPhone 15 Pro 256GB - Colors
(1,  1, 'PHONE-IP15-256-BLK', 'Black Titanium',   119900, NULL,   80000, 45, 187, '0194253123456', '2024-01-02 11:00:00+00'),
(2,  1, 'PHONE-IP15-256-WHT', 'White Titanium',   119900, NULL,   80000, 32, 187, '0194253123457', '2024-01-02 11:00:00+00'),
(3,  1, 'PHONE-IP15-256-BLU', 'Blue Titanium',    119900, NULL,   80000, 28, 187, '0194253123458', '2024-01-02 11:00:00+00'),
(4,  1, 'PHONE-IP15-256-NAT', 'Natural Titanium', 119900, NULL,   80000, 15, 187, '0194253123459', '2024-01-02 11:00:00+00'),

-- iPhone 15 Pro 512GB - Colors
(5,  2, 'PHONE-IP15-512-BLK', 'Black Titanium',   139900, NULL,   95000, 20, 187, '0194253123460', '2024-01-02 11:00:00+00'),
(6,  2, 'PHONE-IP15-512-WHT', 'White Titanium',   139900, NULL,   95000, 18, 187, '0194253123461', '2024-01-02 11:00:00+00'),

-- Samsung Galaxy S24 - Colors
(7,  3, 'PHONE-S24-256-BLK',  'Onyx Black',       89900,  99900,  60000, 55, 167, '8806095123456', '2024-01-02 11:00:00+00'),
(8,  3, 'PHONE-S24-256-VLT',  'Cobalt Violet',    89900,  99900,  60000, 40, 167, '8806095123457', '2024-01-02 11:00:00+00'),
(9,  3, 'PHONE-S24-256-YLW',  'Amber Yellow',     89900,  99900,  60000, 25, 167, '8806095123458', '2024-01-02 11:00:00+00'),

-- Google Pixel 8 - Colors
(10, 4, 'PHONE-PX8-128-BLK',  'Obsidian',         69900,  NULL,   45000, 60, 187, '0195133123456', '2024-01-02 11:00:00+00'),
(11, 4, 'PHONE-PX8-128-HAZ',  'Hazel',            69900,  NULL,   45000, 42, 187, '0195133123457', '2024-01-02 11:00:00+00'),
(12, 4, 'PHONE-PX8-128-RSE',  'Rose',             69900,  NULL,   45000, 35, 187, '0195133123458', '2024-01-02 11:00:00+00'),

-- iPhone Case - Colors
(13, 6, 'ACC-CASE-IP15-BLU',  'Storm Blue',       4900,   NULL,   1500,  120, 25, '0194253234567', '2024-01-03 11:00:00+00'),
(14, 6, 'ACC-CASE-IP15-BLK',  'Black',            4900,   NULL,   1500,  95,  25, '0194253234568', '2024-01-03 11:00:00+00'),
(15, 6, 'ACC-CASE-IP15-RED',  'Red',              4900,   NULL,   1500,  45,  25, '0194253234569', '2024-01-03 11:00:00+00'),

-- Charger - Single variant
(16, 7, 'ACC-CHRG-65W-WHT',   'White',            3999,   4999,   1200,  200, 145, '1234567890123', '2024-01-03 11:00:00+00'),

-- AirPods Max - Colors
(17, 9,  'AUDIO-APP-MAX-SLV', 'Silver',           54900,  NULL,   35000, 22, 384, '0194252123456', '2024-01-04 11:00:00+00'),
(18, 9,  'AUDIO-APP-MAX-GRY', 'Space Gray',       54900,  NULL,   35000, 18, 384, '0194252123457', '2024-01-04 11:00:00+00'),

-- AirPods Pro 2 - Single variant
(19, 10, 'AUDIO-APP-PRO2-WHT', 'White',           24900,  NULL,   15000, 85, 50, '0194252234567', '2024-01-04 11:00:00+00'),

-- Sony XM5 - Colors
(20, 11, 'AUDIO-SONY-XM5-BLK', 'Black',           34900,  39900,  22000, 35, 250, '4548736123456', '2024-01-04 11:00:00+00'),
(21, 11, 'AUDIO-SONY-XM5-SLV', 'Silver',          34900,  39900,  22000, 28, 250, '4548736123457', '2024-01-04 11:00:00+00'),

-- T-Shirt - Sizes
(22, 14, 'CLO-MEN-TSHIRT-M-WHT', 'White - M',     1999,   NULL,   600,   150, 180, '4901234567890', '2024-01-06 11:00:00+00');

SELECT setval('variants_id_seq', 22);

-- ============================================================================
-- VERIFICATION
-- ============================================================================

SELECT '=== PIM/DAM Seed Summary ===' AS info;
SELECT 'Categories:' AS table_name, count(*) AS row_count FROM categories
UNION ALL SELECT 'Products:', count(*) FROM products
UNION ALL SELECT 'Assets:', count(*) FROM assets
UNION ALL SELECT 'Product Images:', count(*) FROM product_images
UNION ALL SELECT 'Variants:', count(*) FROM variants;

-- Sample queries to verify data
SELECT '=== Active Products with Approved EN Images ===' AS info;
SELECT p.sku, p.title, pi.status
FROM products p
JOIN product_images pi ON p.id = pi.product_id
WHERE p.active = TRUE AND pi.locale = 'en' AND pi.status = 'approved' AND pi.is_main = TRUE
ORDER BY p.id
LIMIT 5;

SELECT '=== Category Hierarchy ===' AS info;
SELECT c.id, c.name, p.name AS parent_name
FROM categories c
LEFT JOIN categories p ON c.parent_id = p.id
ORDER BY COALESCE(c.parent_id, 0), c.position;
