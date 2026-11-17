import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, tx, round, hashPassword, checkPassword } from "./db.js";

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(import.meta.dirname, "..", "public");
const SESSION_DAYS = 7;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

// ---------------------------------------------------------------- helpers
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  if (!(req.headers["content-type"] || "").startsWith("application/json")) throw bad("Expected JSON");
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, "Request too large");
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { throw bad("Invalid JSON"); }
}

function getUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  if (!m) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.name, u.phone, u.address, u.role, s.expires
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND u.active = 1`).get(sha(m[1]));
  if (!row || row.expires < Date.now()) return null;
  delete row.expires;
  return row;
}

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires) VALUES (?,?,?)")
    .run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  const secure = process.env.COOKIE_SECURE === "1" || req.headers["x-forwarded-proto"] === "https";
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
}

// simple login throttle: 10 failures per 15 min per ip+username
const failures = new Map();
function throttle(key) {
  const now = Date.now();
  const list = (failures.get(key) || []).filter((t) => now - t < 900_000);
  failures.set(key, list);
  if (list.length >= 10) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
}

const requireUser = (u) => { if (!u) throw new HttpError(401, "Please log in"); return u; };
const requireStaff = (u) => {
  requireUser(u);
  if (u.role === "customer") throw new HttpError(403, "Staff only");
  return u;
};
const requireAdmin = (u) => {
  requireUser(u);
  if (u.role !== "admin") throw new HttpError(403, "Admin only");
  return u;
};

// ------------------------------------------------------------ order logic
const pubProduct = (p) => ({
  id: p.id, name: p.name, emoji: p.emoji, price: p.price, unit: p.unit,
  available: p.stock, status: p.stock <= 0 ? "out" : p.stock <= p.low_stock ? "low" : "ok"
});

function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) throw bad("Add at least one item");
  if (items.length > 100) throw bad("Too many items");
  const merged = new Map();
  for (const it of items) {
    const qty = round(num(it?.qty), 3);
    const id = num(it?.productId);
    if (!Number.isInteger(id) || !(qty > 0) || qty > 100000) throw bad("Invalid item or quantity");
    merged.set(id, round((merged.get(id) || 0) + qty, 3));
  }
  return [...merged].map(([productId, qty]) => ({ productId, qty }));
}

// Replace an order's items. Prices already on the order are kept; new products use today's price.
function writeItems(orderId, items, discount = 0) {
  const old = new Map(db.prepare("SELECT product_id, price FROM order_items WHERE order_id=?").all(orderId)
    .map((r) => [r.product_id, r.price]));
  db.prepare("DELETE FROM order_items WHERE order_id=?").run(orderId);
  const ins = db.prepare(`INSERT INTO order_items (order_id, product_id, name, unit, price, qty, line_total)
    VALUES (?,?,?,?,?,?,?)`);
  let subtotal = 0;
  for (const { productId, qty } of items) {
    const p = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(productId);
    if (!p) throw bad("A product in this order is no longer available");
    const price = old.get(productId) ?? p.price;
    const line = round(price * qty);
    subtotal += line;
    ins.run(orderId, productId, p.name, p.unit, price, qty, line);
  }
  subtotal = round(subtotal);
  discount = Math.min(Math.max(round(discount), 0), subtotal);
  db.prepare("UPDATE orders SET subtotal=?, discount=?, total=? WHERE id=?")
    .run(subtotal, discount, round(subtotal - discount), orderId);
}

function insertOrder(o) {
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO orders
    (customer_id, customer_name, phone, address, channel, status, note) VALUES (?,?,?,?,?, 'pending', ?)`)
    .run(o.customerId ?? null, o.customerName, o.phone || null, o.address || null, o.channel, o.note || null);
  writeItems(+id, o.items, o.discount);
  return +id;
}

// Billing = the moment goods leave the shop: stock goes down here and only here.
function billOrder(id, staffId, payment) {
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
  if (!order) throw new HttpError(404, "Order not found");
  if (order.status !== "pending") throw bad(`Order is already ${order.status}`);
  const items = db.prepare("SELECT * FROM order_items WHERE order_id=?").all(id);
  if (!items.length) throw bad("Order has no items");
  const short = [];
  for (const it of items) {
    const p = db.prepare("SELECT stock, name, unit FROM products WHERE id=?").get(it.product_id);
    if (p.stock < it.qty) short.push(`${p.name}: need ${it.qty} ${p.unit}, only ${p.stock} in stock`);
  }
  if (short.length) throw bad("Not enough stock — " + short.join("; "));
  for (const it of items) {
    db.prepare("UPDATE products SET stock = ROUND(stock - ?, 3) WHERE id=?").run(it.qty, it.product_id);
    db.prepare(`INSERT INTO stock_moves (product_id, qty, kind, ref_order, user_id) VALUES (?,?, 'sale', ?, ?)`)
      .run(it.product_id, -it.qty, id, staffId);
  }
  db.prepare(`UPDATE orders SET status='billed', payment=?, billed_by=?, billed_at=datetime('now') WHERE id=?`)
    .run(payment, staffId, id);
}

const PAYMENTS = ["cash", "upi", "card", "credit"];
const payment = (v) => (PAYMENTS.includes(v) ? v : "cash");

function orderWithItems(o) {
  if (!o) return null;
  o.items = db.prepare("SELECT product_id AS productId, name, unit, price, qty, line_total AS lineTotal FROM order_items WHERE order_id=?").all(o.id);
  return o;
}

// ------------------------------------------------------------------ routes
// [method, pattern, handler(ctx)]; ctx = { req, res, user, body, params, url }
const routes = [];
const route = (method, pattern, fn) =>
  routes.push([method, new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn]);

// ---- public + auth
route("GET", "/api/products", () =>
  db.prepare("SELECT * FROM products WHERE active=1 ORDER BY name").all().map(pubProduct));

route("GET", "/api/me", ({ user }) => ({ user }));

route("POST", "/api/signup", ({ req, res, body }) => {
  const name = str(body.name, 80), phone = str(body.phone, 15).replace(/[\s-]/g, "");
  const password = typeof body.password === "string" ? body.password : "";
  if (!name) throw bad("Enter your name");
  if (!/^\+?\d{10,14}$/.test(phone)) throw bad("Enter a valid phone number (10–14 digits)");
  if (password.length < 6 || password.length > 100) throw bad("Password must be at least 6 characters");
  if (db.prepare("SELECT 1 FROM users WHERE username=?").get(phone)) throw bad("This phone number is already registered. Please log in.");
  const { lastInsertRowid: id } = db.prepare(
    "INSERT INTO users (username, name, phone, address, role, pass_hash) VALUES (?,?,?,?, 'customer', ?)")
    .run(phone, name, phone, str(body.address, 300) || null, hashPassword(password));
  const cookie = startSession(req, res, +id);
  return { user: getUserById(+id), _headers: { "Set-Cookie": cookie } };
});

const getUserById = (id) => db.prepare("SELECT id, username, name, phone, address, role FROM users WHERE id=?").get(id);

route("POST", "/api/login", ({ req, res, body }) => {
  const username = str(body.username, 40).replace(/[\s-]/g, "").toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  const key = `${req.socket.remoteAddress}|${username}`;
  throttle(key);
  const u = db.prepare("SELECT * FROM users WHERE username=? AND active=1").get(username);
  if (!u || !checkPassword(password, u.pass_hash)) {
    failures.get(key).push(Date.now());
    throw new HttpError(401, "Wrong username or password");
  }
  failures.delete(key);
  return { user: getUserById(u.id), _headers: { "Set-Cookie": startSession(req, res, u.id) } };
});

route("POST", "/api/logout", ({ req }) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || "");
  if (m) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha(m[1]));
  return { ok: true, _headers: { "Set-Cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" } };
});

route("POST", "/api/change-password", ({ user, body }) => {
  requireUser(user);
  const full = db.prepare("SELECT pass_hash FROM users WHERE id=?").get(user.id);
  if (!checkPassword(String(body.current || ""), full.pass_hash)) throw bad("Current password is wrong");
  const pw = String(body.password || "");
  if (pw.length < 6) throw bad("New password must be at least 6 characters");
  db.prepare("UPDATE users SET pass_hash=? WHERE id=?").run(hashPassword(pw), user.id);
  return { ok: true };
});

// ---- customer orders (online)
route("POST", "/api/orders", ({ user, body }) => {
  requireUser(user);
  if (user.role !== "customer") throw new HttpError(403, "Staff should use the Billing screen");
  const items = cleanItems(body.items);
  for (const it of items) {                    // stock is not reserved, but don't accept impossible orders
    const p = db.prepare("SELECT name, stock, unit FROM products WHERE id=? AND active=1").get(it.productId);
    if (!p) throw bad("A product is no longer available");
    if (it.qty > p.stock) throw bad(`Only ${p.stock} ${p.unit} of ${p.name} available`);
  }
  const address = str(body.address, 300);
  if (!address) throw bad("Enter a delivery address or write 'Pickup'");
  const id = tx(() => insertOrder({
    customerId: user.id, customerName: user.name, phone: user.phone, address,
    channel: "online", note: str(body.note, 300), items
  }));
  db.prepare("UPDATE users SET address=? WHERE id=?").run(address, user.id);
  return orderWithItems(db.prepare("SELECT * FROM orders WHERE id=?").get(id));
});

route("GET", "/api/orders", ({ user }) => {
  requireUser(user);
  return db.prepare("SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 100").all(user.id).map(orderWithItems);
});

route("POST", "/api/orders/:id/cancel", ({ user, params }) => {
  requireUser(user);
  const r = db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND customer_id=? AND status='pending'")
    .run(+params.id, user.id);
  if (!r.changes) throw bad("Only your pending orders can be cancelled");
  return { ok: true };
});

// ---- staff: orders & billing
route("GET", "/api/admin/summary", ({ user }) => {
  requireStaff(user);
  const one = (sql) => db.prepare(sql).get();
  return {
    pending: one("SELECT COUNT(*) n FROM orders WHERE status='pending'").n,
    low: one("SELECT COUNT(*) n FROM products WHERE active=1 AND stock <= low_stock").n,
    todaySales: one("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status='billed' AND date(billed_at)=date('now')").n,
    todayBills: one("SELECT COUNT(*) n FROM orders WHERE status='billed' AND date(billed_at)=date('now')").n
  };
});

route("GET", "/api/admin/orders", ({ user, url }) => {
  requireStaff(user);
  const status = url.searchParams.get("status");
  const q = str(url.searchParams.get("q") || "", 50);
  const where = [], args = [];
  if (["pending", "billed", "cancelled"].includes(status)) { where.push("status=?"); args.push(status); }
  if (q) {
    where.push("(customer_name LIKE ? OR phone LIKE ? OR id = ?)");
    args.push(`%${q}%`, `%${q}%`, +q || 0);
  }
  const sql = `SELECT * FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 200`;
  return db.prepare(sql).all(...args).map(orderWithItems);
});

route("PUT", "/api/admin/orders/:id", ({ user, params, body }) => {
  requireStaff(user);
  const items = cleanItems(body.items);
  tx(() => {
    const o = db.prepare("SELECT status FROM orders WHERE id=?").get(+params.id);
    if (!o) throw new HttpError(404, "Order not found");
    if (o.status !== "pending") throw bad("Only pending orders can be edited");
    writeItems(+params.id, items, num(body.discount) || 0);
  });
  return orderWithItems(db.prepare("SELECT * FROM orders WHERE id=?").get(+params.id));
});

route("POST", "/api/admin/orders/:id/bill", ({ user, params, body }) => {
  requireStaff(user);
  tx(() => {
    if (body.items) {                       // staff may adjust quantities while billing
      const o = db.prepare("SELECT status FROM orders WHERE id=?").get(+params.id);
      if (o?.status === "pending") writeItems(+params.id, cleanItems(body.items), num(body.discount) || 0);
    } else if (num(body.discount) >= 0) {
      const o = db.prepare("SELECT subtotal FROM orders WHERE id=?").get(+params.id);
      if (o) {
        const d = Math.min(round(num(body.discount)), o.subtotal);
        db.prepare("UPDATE orders SET discount=?, total=? WHERE id=?").run(d, round(o.subtotal - d), +params.id);
      }
    }
    billOrder(+params.id, user.id, payment(body.payment));
  });
  return orderWithItems(db.prepare("SELECT * FROM orders WHERE id=?").get(+params.id));
});

route("POST", "/api/admin/orders/:id/cancel", ({ user, params }) => {
  requireStaff(user);
  const r = db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'").run(+params.id);
  if (!r.changes) throw bad("Only pending orders can be cancelled");
  return { ok: true };
});

// Void a billed bill: stock is returned (admin only)
route("POST", "/api/admin/orders/:id/void", ({ user, params, body }) => {
  requireAdmin(user);
  tx(() => {
    const o = db.prepare("SELECT * FROM orders WHERE id=?").get(+params.id);
    if (!o || o.status !== "billed") throw bad("Only billed orders can be voided");
    for (const it of db.prepare("SELECT * FROM order_items WHERE order_id=?").all(o.id)) {
      db.prepare("UPDATE products SET stock = ROUND(stock + ?, 3) WHERE id=?").run(it.qty, it.product_id);
      db.prepare(`INSERT INTO stock_moves (product_id, qty, kind, ref_order, note, user_id) VALUES (?,?, 'adjust', ?, ?, ?)`)
        .run(it.product_id, it.qty, o.id, `Bill #${o.id} voided. ${str(body.reason, 200)}`.trim(), user.id);
    }
    db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(o.id);
  });
  return { ok: true };
});

// New bill at the counter or for a phone call: creates and bills in one step
route("POST", "/api/admin/bills", ({ user, body }) => {
  requireStaff(user);
  const channel = body.channel === "phone" ? "phone" : "counter";
  const items = cleanItems(body.items);
  const phone = str(body.phone, 15).replace(/[\s-]/g, "");
  const customer = phone ? db.prepare("SELECT id, name FROM users WHERE username=? AND role='customer'").get(phone) : null;
  const id = tx(() => {
    const oid = insertOrder({
      customerId: customer?.id, customerName: str(body.customerName, 80) || customer?.name || "Walk-in customer",
      phone, address: str(body.address, 300), channel, note: str(body.note, 300), items, discount: num(body.discount) || 0
    });
    billOrder(oid, user.id, payment(body.payment));
    return oid;
  });
  return orderWithItems(db.prepare("SELECT * FROM orders WHERE id=?").get(id));
});

route("GET", "/api/admin/customers", ({ user, url }) => {
  requireStaff(user);
  const q = `%${str(url.searchParams.get("q") || "", 40)}%`;
  return db.prepare(`SELECT id, name, phone, address FROM users WHERE role='customer' AND active=1
    AND (name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 10`).all(q, q);
});

route("GET", "/api/admin/products", ({ user }) => {
  requireStaff(user);
  return db.prepare("SELECT id, name, emoji, price, unit, stock, low_stock AS lowStock FROM products WHERE active=1 ORDER BY name").all();
});

// ---- admin: stock, products, users
route("POST", "/api/admin/stock-in", ({ user, body }) => {
  requireAdmin(user);
  const lines = Array.isArray(body.items) ? body.items : [body];   // one delivery can have many products
  if (!lines.length || lines.length > 100) throw bad("Add at least one product");
  tx(() => {
    for (const l of lines) {
      const qty = round(num(l.qty), 3), cost = l.costPrice === "" || l.costPrice == null ? null : num(l.costPrice);
      if (!(qty > 0)) throw bad("Enter a quantity greater than 0");
      if (cost !== null && !(cost >= 0)) throw bad("Invalid cost price");
      const p = db.prepare("SELECT id FROM products WHERE id=? AND active=1").get(num(l.productId));
      if (!p) throw bad("Unknown product");
      db.prepare("UPDATE products SET stock = ROUND(stock + ?, 3) WHERE id=?").run(qty, p.id);
      db.prepare(`INSERT INTO stock_moves (product_id, qty, kind, supplier, cost_price, note, user_id)
        VALUES (?,?, 'in', ?, ?, ?, ?)`).run(p.id, qty, str(body.supplier, 100) || null, cost, str(body.note, 200) || null, user.id);
    }
  });
  return { ok: true };
});

// Correct stock after a count (damage, spoilage, mistakes). The reason is recorded.
route("POST", "/api/admin/stock-adjust", ({ user, body }) => {
  requireAdmin(user);
  const target = num(body.newStock), reason = str(body.reason, 200);
  if (!(target >= 0)) throw bad("Enter the counted quantity");
  if (!reason) throw bad("Give a reason (e.g. damaged, recount)");
  tx(() => {
    const p = db.prepare("SELECT id, stock FROM products WHERE id=? AND active=1").get(num(body.productId));
    if (!p) throw bad("Unknown product");
    const diff = round(target - p.stock, 3);
    if (!diff) return;
    db.prepare("UPDATE products SET stock=? WHERE id=?").run(round(target, 3), p.id);
    db.prepare("INSERT INTO stock_moves (product_id, qty, kind, note, user_id) VALUES (?,?, 'adjust', ?, ?)")
      .run(p.id, diff, reason, user.id);
  });
  return { ok: true };
});

route("GET", "/api/admin/stock-moves", ({ user, url }) => {
  requireAdmin(user);
  const kind = url.searchParams.get("kind");
  return db.prepare(`SELECT m.id, m.created, m.kind, m.qty, m.supplier, m.cost_price AS costPrice, m.note, m.ref_order AS refOrder,
      p.name AS product, p.unit, u.name AS by
    FROM stock_moves m JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.user_id
    ${["in", "sale", "adjust"].includes(kind) ? "WHERE m.kind = '" + kind + "'" : ""}
    ORDER BY m.id DESC LIMIT 200`).all();
});

function productFields(body, partial) {
  const f = {};
  const set = (k, v) => { f[k] = v; };
  if (!partial || body.name !== undefined) { const v = str(body.name, 60); if (!v) throw bad("Enter a name"); set("name", v); }
  if (!partial || body.price !== undefined) { const v = num(body.price); if (!(v >= 0)) throw bad("Invalid price"); set("price", round(v)); }
  if (!partial || body.unit !== undefined) { const v = str(body.unit, 12); if (!v) throw bad("Enter a unit"); set("unit", v); }
  if (!partial || body.lowStock !== undefined) { const v = num(body.lowStock); if (!(v >= 0)) throw bad("Invalid alert level"); set("low_stock", v); }
  if (body.emoji !== undefined) set("emoji", str(body.emoji, 8) || "📦");
  return f;
}

route("POST", "/api/admin/products", ({ user, body }) => {
  requireAdmin(user);
  const f = productFields(body, false);
  const stock = body.stock === undefined ? 0 : num(body.stock);
  if (!(stock >= 0)) throw bad("Invalid opening stock");
  if (db.prepare("SELECT 1 FROM products WHERE active=1 AND lower(name)=lower(?)").get(f.name)) throw bad(`${f.name} already exists`);
  return tx(() => {
    const { lastInsertRowid: id } = db.prepare("INSERT INTO products (name, emoji, price, unit, stock, low_stock) VALUES (?,?,?,?,?,?)")
      .run(f.name, f.emoji || "📦", f.price, f.unit, stock, f.low_stock);
    if (stock > 0) db.prepare("INSERT INTO stock_moves (product_id, qty, kind, note, user_id) VALUES (?,?, 'in', 'Opening stock', ?)").run(id, stock, user.id);
    return { id: +id };
  });
});

route("PUT", "/api/admin/products/:id", ({ user, params, body }) => {
  requireAdmin(user);
  const f = productFields(body, true);
  const keys = Object.keys(f);
  if (!keys.length) throw bad("Nothing to update");
  const r = db.prepare(`UPDATE products SET ${keys.map((k) => k + "=?").join(",")} WHERE id=? AND active=1`)
    .run(...keys.map((k) => f[k]), +params.id);
  if (!r.changes) throw new HttpError(404, "Product not found");
  return { ok: true };
});

route("DELETE", "/api/admin/products/:id", ({ user, params }) => {   // hidden, not erased, so old bills stay intact
  requireAdmin(user);
  db.prepare("UPDATE products SET active=0 WHERE id=?").run(+params.id);
  return { ok: true };
});

route("GET", "/api/admin/users", ({ user }) => {
  requireAdmin(user);
  return db.prepare("SELECT id, username, name, role, active, created FROM users WHERE role != 'customer' ORDER BY id").all();
});

route("POST", "/api/admin/users", ({ user, body }) => {
  requireAdmin(user);
  const username = str(body.username, 30).toLowerCase(), name = str(body.name, 80);
  const pw = typeof body.password === "string" ? body.password : "";
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw bad("Username: 3–30 letters, digits, . _ -");
  if (!name) throw bad("Enter a name");
  if (pw.length < 6) throw bad("Password must be at least 6 characters");
  if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) throw bad("Username already taken");
  db.prepare("INSERT INTO users (username, name, role, pass_hash) VALUES (?,?, 'staff', ?)").run(username, name, hashPassword(pw));
  return { ok: true };
});

route("PUT", "/api/admin/users/:id", ({ user, params, body }) => {
  requireAdmin(user);
  const id = +params.id;
  if (id === user.id) throw bad("You can't change your own account here");
  const u = db.prepare("SELECT role FROM users WHERE id=? AND role != 'customer'").get(id);
  if (!u) throw new HttpError(404, "User not found");
  if (body.active !== undefined) {
    db.prepare("UPDATE users SET active=? WHERE id=?").run(body.active ? 1 : 0, id);
    if (!body.active) db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  }
  if (typeof body.password === "string" && body.password) {
    if (body.password.length < 6) throw bad("Password must be at least 6 characters");
    db.prepare("UPDATE users SET pass_hash=? WHERE id=?").run(hashPassword(body.password), id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  }
  return { ok: true };
});

// ------------------------------------------------------------ static files
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };

function serveStatic(req, res, pathname) {
  if (pathname === "/admin" || pathname === "/admin/") pathname = "/admin.html";
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(PUBLIC, path.normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, "Not found");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
      return serveStatic(req, res, url.pathname);
    }
    for (const [method, re, fn] of routes) {
      const m = method === req.method && re.exec(url.pathname);
      if (!m) continue;
      const body = method === "GET" || method === "DELETE" ? {} : await readJson(req);
      let out = fn({ req, res, user: getUser(req), body, params: m.groups || {}, url }) ?? { ok: true };
      let headers = {};
      if (out._headers) { headers = out._headers; out = { ...out }; delete out._headers; }
      return send(res, 200, out, headers);
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: "Something went wrong" });
  }
});

server.listen(PORT, () => console.log(`Fresh Mart running → http://localhost:${PORT}   (staff: /admin)`));
