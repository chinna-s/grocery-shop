import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = process.env.DATA_DIR || path.join(import.meta.dirname, "..", "data");
fs.mkdirSync(dir, { recursive: true });
export const db = new DatabaseSync(path.join(dir, "shop.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,      -- customers: their phone number
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','staff','customer')),
  pass_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '📦',
  price REAL NOT NULL CHECK (price >= 0),
  unit TEXT NOT NULL,
  stock REAL NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
-- Every change to stock is recorded here: goods received, sales, corrections.
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,                  -- + added, - removed
  kind TEXT NOT NULL CHECK (kind IN ('in','sale','adjust')),
  supplier TEXT,
  cost_price REAL,
  ref_order INTEGER,
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES users(id),
  customer_name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('online','phone','counter')),
  status TEXT NOT NULL CHECK (status IN ('pending','billed','cancelled')),
  note TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  payment TEXT,
  billed_by INTEGER REFERENCES users(id),
  billed_at TEXT,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  price REAL NOT NULL,
  qty REAL NOT NULL CHECK (qty > 0),
  line_total REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`);

export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const round = (n, d = 2) => +(+n).toFixed(d);

// ---- passwords ----
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}
export function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const h = crypto.scryptSync(pw, Buffer.from(salt, "hex"), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, "hex"));
}

// ---- first-run seed ----
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString("base64url");
  db.prepare("INSERT INTO users (username, name, role, pass_hash) VALUES (?,?,?,?)")
    .run("admin", "Shop Owner", "admin", hashPassword(pw));
  console.log("\n  First run: created admin account");
  console.log("    username: admin");
  console.log(`    password: ${process.env.ADMIN_PASSWORD ? "(from ADMIN_PASSWORD)" : pw}\n`);
}
if (!db.prepare("SELECT 1 FROM products").get()) {
  const ins = db.prepare("INSERT INTO products (name, emoji, price, unit, stock, low_stock) VALUES (?,?,?,?,?,?)");
  [["Rice", "🍚", 75, "kg", 100, 20], ["Dal", "🫘", 140, "kg", 50, 10], ["Wheat", "🌾", 45, "kg", 80, 15],
   ["Sugar", "🧂", 48, "kg", 60, 10], ["Maida", "🥣", 50, "kg", 40, 8]].forEach((p) => ins.run(...p));
}
