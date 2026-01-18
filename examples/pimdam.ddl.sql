-- PIM/DAM Schema DDL
--
-- Product Information Management / Digital Asset Management schema.
-- Run with: psql -d your_db -f examples/pimdam.ddl.sql
--
-- Or use the CLI:
--   pnpm dbsp generate ddl --schema ./examples/pimdam.schema.ts

-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS variants CASCADE;
DROP TABLE IF EXISTS product_images CASCADE;
DROP TABLE IF EXISTS assets CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS categories CASCADE;

-- Categories: hierarchical product taxonomy
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    description TEXT,
    parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    position INTEGER DEFAULT 0,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_categories_parent ON categories(parent_id);
CREATE INDEX idx_categories_slug ON categories(slug);

-- Products: main product catalog
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    sku VARCHAR(100) NOT NULL UNIQUE,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    brand VARCHAR(255),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP,
    deleted_at TIMESTAMP
);

CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_active ON products(active) WHERE active = TRUE;

-- Assets: Digital Asset Management
CREATE TABLE assets (
    id SERIAL PRIMARY KEY,
    kind VARCHAR(50) NOT NULL, -- 'image', 'video', 'document'
    filename VARCHAR(500) NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    mime VARCHAR(100) NOT NULL,
    width INTEGER,
    height INTEGER,
    size_bytes INTEGER NOT NULL,
    storage_key VARCHAR(500) NOT NULL,
    alt_text VARCHAR(500),
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_assets_kind ON assets(kind);
CREATE INDEX idx_assets_sha256 ON assets(sha256);

-- Product Images: junction table with localization and workflow
CREATE TABLE product_images (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    locale VARCHAR(10) NOT NULL, -- 'en', 'fr', 'de', etc.
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    is_main BOOLEAN DEFAULT FALSE,
    position INTEGER DEFAULT 0,
    rejected_reason TEXT,
    approved_by VARCHAR(255),
    approved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP
);

CREATE INDEX idx_product_images_product ON product_images(product_id);
CREATE INDEX idx_product_images_locale ON product_images(locale);
CREATE INDEX idx_product_images_status ON product_images(status);
CREATE UNIQUE INDEX idx_product_images_main ON product_images(product_id, locale)
    WHERE is_main = TRUE AND deleted_at IS NULL;

-- Variants: product SKU variations
CREATE TABLE variants (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sku VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    price_cents INTEGER NOT NULL,
    compare_at_price_cents INTEGER,
    cost_cents INTEGER,
    stock INTEGER DEFAULT 0,
    weight_grams INTEGER,
    barcode VARCHAR(50),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_variants_product ON variants(product_id);
CREATE INDEX idx_variants_sku ON variants(sku);
CREATE INDEX idx_variants_stock ON variants(stock) WHERE stock > 0;

-- Verify
SELECT 'Tables created:' AS info;
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('categories', 'products', 'assets', 'product_images', 'variants')
ORDER BY table_name;
