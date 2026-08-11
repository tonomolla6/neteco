import fs from 'node:fs'
import Database from 'better-sqlite3'
import { runSeed } from '../db/seed'

let _db: Database.Database | null = null

export function useDb() {
  if (!_db) {
    fs.mkdirSync('.data', { recursive: true })
    _db = new Database('.data/neteco.db')
    _db.pragma('journal_mode = WAL')
    _db.pragma('foreign_keys = ON')
    migrate(_db)
    runSeed(_db)
  }
  return _db
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      parent_id INTEGER,
      sort INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      brand TEXT,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      short_desc TEXT,
      description TEXT,
      usage TEXT,
      badges TEXT DEFAULT '[]',
      visual TEXT,
      featured INTEGER DEFAULT 0,
      series TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      format TEXT NOT NULL,
      sku TEXT UNIQUE,
      price INTEGER NOT NULL,
      stock INTEGER DEFAULT 100,
      units REAL,
      unit_label TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      company TEXT,
      role TEXT NOT NULL DEFAULT 'customer',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      user_id INTEGER,
      status TEXT NOT NULL,
      name TEXT,
      company TEXT,
      nif TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      zip TEXT,
      city TEXT,
      province TEXT,
      notes TEXT,
      shipping_method TEXT,
      shipping_cost INTEGER DEFAULT 0,
      payment_method TEXT,
      subtotal INTEGER,
      tax INTEGER,
      total INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER,
      variant_id INTEGER,
      name TEXT,
      format TEXT,
      sku TEXT,
      price INTEGER,
      qty INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  `)

  // migraciones aditivas: permiten evolucionar el esquema sin borrar la base de datos
  const addColumn = (table: string, col: string, ddl: string) => {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name)
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
  addColumn('users', 'role', "role TEXT NOT NULL DEFAULT 'customer'")
  addColumn('products', 'series', 'series TEXT')
  addColumn('variants', 'units', 'units REAL')
  addColumn('variants', 'unit_label', 'unit_label TEXT')
  // foto real del producto (ruta bajo /public); si es NULL la UI usa la ilustración SVG
  addColumn('products', 'image', 'image TEXT')
  // ficha técnica en PDF (ruta bajo /public/docs/fichas)
  addColumn('products', 'datasheet', 'datasheet TEXT')
  // 0 = oculto/descatalogado: no aparece en la web pero se conserva con todo su histórico
  addColumn('products', 'active', 'active INTEGER NOT NULL DEFAULT 1')
  // color (hex) e imagen propios de cada variante (p. ej. mantelería por colores)
  addColumn('variants', 'color', 'color TEXT')
  addColumn('variants', 'image', 'image TEXT')
}
