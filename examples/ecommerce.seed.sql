-- E-Commerce Schema Seed Data
--
-- Usage:
--   psql -d your_db -f examples/ecommerce.seed.sql

TRUNCATE order_items, orders, addresses, customers, variants, products, categories RESTART IDENTITY CASCADE;

-- Categories (hierarchical)
-- Level 0: Root categories
INSERT INTO categories (id, name, slug, parent_id, sort_order) VALUES
    (1, 'Electronics', 'electronics', NULL, 1),
    (2, 'Clothing', 'clothing', NULL, 2),
    (3, 'Books', 'books', NULL, 3);

-- Level 1: Subcategories
INSERT INTO categories (id, name, slug, parent_id, sort_order) VALUES
    (4, 'Computers', 'computers', 1, 1),
    (5, 'Phones', 'phones', 1, 2),
    (6, 'Audio', 'audio', 1, 3),
    (7, 'Men', 'men', 2, 1),
    (8, 'Women', 'women', 2, 2),
    (9, 'Fiction', 'fiction', 3, 1),
    (10, 'Non-Fiction', 'non-fiction', 3, 2);

-- Level 2: Sub-subcategories
INSERT INTO categories (id, name, slug, parent_id, sort_order) VALUES
    (11, 'Laptops', 'laptops', 4, 1),
    (12, 'Desktops', 'desktops', 4, 2),
    (13, 'Smartphones', 'smartphones', 5, 1),
    (14, 'Headphones', 'headphones', 6, 1),
    (15, 'Speakers', 'speakers', 6, 2),
    (16, 'T-Shirts', 't-shirts', 7, 1),
    (17, 'Jeans', 'jeans', 7, 2),
    (18, 'Dresses', 'dresses', 8, 1),
    (19, 'Science Fiction', 'science-fiction', 9, 1),
    (20, 'Technical', 'technical', 10, 1);

-- Reset sequence
SELECT setval('categories_id_seq', 20, true);

-- Products
INSERT INTO products (sku, name, description, price, stock, category_id, active) VALUES
    ('LAPTOP-001', 'ProBook 15', 'High-performance laptop for professionals', 1299.99, 50, 11, TRUE),
    ('LAPTOP-002', 'UltraLight 13', 'Lightweight laptop for travel', 999.99, 30, 11, TRUE),
    ('PHONE-001', 'SmartPhone X', 'Latest flagship smartphone', 899.99, 100, 13, TRUE),
    ('PHONE-002', 'SmartPhone SE', 'Budget-friendly smartphone', 449.99, 200, 13, TRUE),
    ('HEADPHONE-001', 'NoiseCancel Pro', 'Premium noise-canceling headphones', 349.99, 75, 14, TRUE),
    ('HEADPHONE-002', 'BudsPro', 'True wireless earbuds', 199.99, 150, 14, TRUE),
    ('SPEAKER-001', 'SoundBar 500', 'Home theater soundbar', 299.99, 40, 15, TRUE),
    ('TSHIRT-001', 'Classic Tee', '100% cotton t-shirt', 29.99, 500, 16, TRUE),
    ('JEANS-001', 'Slim Fit Denim', 'Modern slim fit jeans', 79.99, 200, 17, TRUE),
    ('DRESS-001', 'Summer Dress', 'Lightweight summer dress', 89.99, 100, 18, TRUE),
    ('BOOK-001', 'Dune', 'Classic science fiction novel', 14.99, 1000, 19, TRUE),
    ('BOOK-002', 'PostgreSQL Guide', 'Complete database guide', 49.99, 200, 20, TRUE),
    ('DESKTOP-001', 'PowerStation', 'High-end desktop workstation', 2499.99, 20, 12, TRUE),
    ('PHONE-003', 'SmartPhone Max', 'Premium smartphone (discontinued)', 1099.99, 0, 13, FALSE);

-- Variants
INSERT INTO variants (product_id, sku, name, price_modifier, stock) VALUES
    -- Laptop variants
    (1, 'LAPTOP-001-8GB', '8GB RAM', 0, 20),
    (1, 'LAPTOP-001-16GB', '16GB RAM', 200, 20),
    (1, 'LAPTOP-001-32GB', '32GB RAM', 500, 10),
    -- Phone variants
    (3, 'PHONE-001-64GB', '64GB Storage', 0, 40),
    (3, 'PHONE-001-128GB', '128GB Storage', 100, 40),
    (3, 'PHONE-001-256GB', '256GB Storage', 200, 20),
    -- T-shirt variants
    (8, 'TSHIRT-001-S', 'Small', 0, 100),
    (8, 'TSHIRT-001-M', 'Medium', 0, 200),
    (8, 'TSHIRT-001-L', 'Large', 0, 150),
    (8, 'TSHIRT-001-XL', 'X-Large', 0, 50),
    -- Jeans variants
    (9, 'JEANS-001-30', 'Waist 30"', 0, 50),
    (9, 'JEANS-001-32', 'Waist 32"', 0, 80),
    (9, 'JEANS-001-34', 'Waist 34"', 0, 50),
    (9, 'JEANS-001-36', 'Waist 36"', 0, 20);

-- Customers
INSERT INTO customers (email, first_name, last_name, phone) VALUES
    ('alice@example.com', 'Alice', 'Johnson', '+1-555-0101'),
    ('bob@example.com', 'Bob', 'Smith', '+1-555-0102'),
    ('carol@example.com', 'Carol', 'Williams', NULL),
    ('david@example.com', 'David', 'Brown', '+1-555-0104'),
    ('emma@example.com', 'Emma', 'Davis', '+1-555-0105');

-- Addresses
INSERT INTO addresses (customer_id, type, street, city, postal_code, country, is_default) VALUES
    -- Alice
    (1, 'shipping', '123 Main St', 'New York', '10001', 'USA', TRUE),
    (1, 'billing', '123 Main St', 'New York', '10001', 'USA', TRUE),
    -- Bob
    (2, 'shipping', '456 Oak Ave', 'Los Angeles', '90001', 'USA', TRUE),
    (2, 'billing', '789 Business Blvd', 'Los Angeles', '90002', 'USA', TRUE),
    -- Carol
    (3, 'shipping', '321 Pine Rd', 'Chicago', '60601', 'USA', TRUE),
    (3, 'billing', '321 Pine Rd', 'Chicago', '60601', 'USA', TRUE),
    -- David
    (4, 'shipping', '555 Elm St', 'Houston', '77001', 'USA', TRUE),
    (4, 'billing', '555 Elm St', 'Houston', '77001', 'USA', TRUE),
    -- Emma
    (5, 'shipping', '777 Cedar Ln', 'Phoenix', '85001', 'USA', TRUE),
    (5, 'billing', '888 Work Plaza', 'Phoenix', '85002', 'USA', FALSE);

-- Orders
INSERT INTO orders (order_number, customer_id, status, total, shipping_address_id, billing_address_id, created_at) VALUES
    ('ORD-2024-001', 1, 'delivered', 1499.98, 1, 2, '2024-01-05 10:00:00+00'),
    ('ORD-2024-002', 2, 'shipped', 349.99, 3, 4, '2024-01-10 14:30:00+00'),
    ('ORD-2024-003', 1, 'paid', 94.98, 1, 2, '2024-01-12 09:00:00+00'),
    ('ORD-2024-004', 3, 'pending', 999.99, 5, 6, '2024-01-15 11:00:00+00'),
    ('ORD-2024-005', 4, 'delivered', 179.97, 7, 8, '2024-01-08 16:00:00+00'),
    ('ORD-2024-006', 5, 'shipped', 1099.98, 9, 10, '2024-01-18 08:00:00+00'),
    ('ORD-2024-007', 2, 'cancelled', 449.99, 3, 4, '2024-01-20 12:00:00+00');

-- Order Items
INSERT INTO order_items (order_id, product_id, variant_id, quantity, unit_price, total_price) VALUES
    -- Order 1: Alice - Laptop + Phone
    (1, 1, 2, 1, 1499.99, 1499.99),  -- ProBook 16GB
    -- Order 2: Bob - Headphones
    (2, 5, NULL, 1, 349.99, 349.99),  -- NoiseCancel Pro
    -- Order 3: Alice - Books
    (3, 11, NULL, 2, 14.99, 29.98),   -- 2x Dune
    (3, 12, NULL, 1, 49.99, 49.99),   -- PostgreSQL Guide
    (3, 11, NULL, 1, 14.99, 14.99),   -- Another Dune
    -- Order 4: Carol - Laptop
    (4, 2, NULL, 1, 999.99, 999.99),  -- UltraLight 13
    -- Order 5: David - Clothing
    (5, 8, 7, 2, 29.99, 59.98),       -- 2x Classic Tee (Small)
    (5, 9, 11, 1, 79.99, 79.99),      -- Slim Fit Denim (30")
    (5, 8, 8, 1, 29.99, 29.99),       -- Classic Tee (Medium)
    -- Order 6: Emma - Phone + Earbuds
    (6, 3, 5, 1, 999.99, 999.99),     -- SmartPhone X (128GB)
    (6, 6, NULL, 1, 199.99, 199.99),  -- BudsPro
    -- Order 7: Bob - Cancelled phone order
    (7, 4, NULL, 1, 449.99, 449.99);  -- SmartPhone SE

-- Verify
SELECT 'Categories:', count(*) FROM categories;
SELECT 'Products:', count(*) FROM products;
SELECT 'Variants:', count(*) FROM variants;
SELECT 'Customers:', count(*) FROM customers;
SELECT 'Addresses:', count(*) FROM addresses;
SELECT 'Orders:', count(*) FROM orders;
SELECT 'Order Items:', count(*) FROM order_items;

-- Example queries to test:
-- Get all categories in hierarchy:
-- WITH RECURSIVE cat_tree AS (
--   SELECT id, name, parent_id, 0 as depth FROM categories WHERE parent_id IS NULL
--   UNION ALL
--   SELECT c.id, c.name, c.parent_id, ct.depth + 1 FROM categories c JOIN cat_tree ct ON c.parent_id = ct.id
-- ) SELECT * FROM cat_tree ORDER BY depth, id;

-- Get products with category path:
-- SELECT p.name, c.name as category FROM products p JOIN categories c ON p.category_id = c.id;
