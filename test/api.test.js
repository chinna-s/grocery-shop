// End-to-end API test. Starts the real server on a temporary database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mart-"));
const PORT = 4100 + Math.floor(Math.random() * 500);
const base = `http://localhost:${PORT}`;
let proc;

async function call(method, url, body, jar) {
  const r = await fetch(base + url, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(jar?.cookie ? { Cookie: jar.cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const sc = r.headers.get("set-cookie");
  if (sc && jar) jar.cookie = sc.split(";")[0];
  return { status: r.status, data: await r.json() };
}

before(async () => {
  proc = spawn(process.execPath, ["server/server.js"], {
    env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_PASSWORD: "admin-pass-1" }, stdio: "pipe"
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + "/api/products"); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server did not start");
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const admin = {}, staff = {}, cust = {};
const stockOf = async (name) => (await call("GET", "/api/admin/products", null, admin)).data.find((p) => p.name === name).stock;

test("admin login, bad password rejected", async () => {
  assert.equal((await call("POST", "/api/login", { username: "admin", password: "nope" })).status, 401);
  const r = await call("POST", "/api/login", { username: "admin", password: "admin-pass-1" }, admin);
  assert.equal(r.data.user.role, "admin");
});

test("only admin can receive stock; goods-in raises stock and is logged", async () => {
  assert.equal((await call("POST", "/api/admin/stock-in", { productId: 1, qty: 5 })).status, 401);
  const before = await stockOf("Rice");
  const r = await call("POST", "/api/admin/stock-in", { supplier: "ABC Traders", items: [{ productId: 1, qty: 25, costPrice: 60 }, { productId: 2, qty: 10 }] }, admin);
  assert.equal(r.status, 200);
  assert.equal(await stockOf("Rice"), before + 25);
  const moves = (await call("GET", "/api/admin/stock-moves?kind=in", null, admin)).data;
  assert.ok(moves.some((m) => m.product === "Rice" && m.qty === 25 && m.supplier === "ABC Traders"));
});

test("staff account: can bill, cannot receive stock", async () => {
  assert.equal((await call("POST", "/api/admin/users", { username: "ravi", name: "Ravi", password: "secret1" }, admin)).status, 200);
  await call("POST", "/api/login", { username: "ravi", password: "secret1" }, staff);
  assert.equal((await call("POST", "/api/admin/stock-in", { productId: 1, qty: 5 }, staff)).status, 403);
  assert.equal((await call("GET", "/api/admin/orders", null, staff)).status, 200);
});

test("customer signs up, orders online; stock is NOT reduced until billed", async () => {
  const s = await call("POST", "/api/signup", { name: "Meena", phone: "98765 43210", password: "meena123" }, cust);
  assert.equal(s.data.user.role, "customer");
  assert.equal((await call("GET", "/api/admin/orders", null, cust)).status, 403);
  const rice = await stockOf("Rice");
  const o = await call("POST", "/api/orders", { address: "12 Main St", items: [{ productId: 1, qty: 2.5 }, { productId: 3, qty: 1 }] }, cust);
  assert.equal(o.status, 200);
  assert.equal(o.data.status, "pending");
  assert.equal(o.data.total, 2.5 * 75 + 45);
  assert.equal(await stockOf("Rice"), rice);
  cust.orderId = o.data.id; cust.rice = rice;
});

test("customer cannot order more than is in stock", async () => {
  const r = await call("POST", "/api/orders", { address: "x", items: [{ productId: 1, qty: 99999 }] }, cust);
  assert.equal(r.status, 400);
});

test("staff bills the pending order: stock goes down, double billing refused", async () => {
  const r = await call("POST", `/api/admin/orders/${cust.orderId}/bill`, { payment: "upi" }, staff);
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "billed");
  assert.equal(r.data.payment, "upi");
  assert.equal(await stockOf("Rice"), cust.rice - 2.5);
  assert.equal((await call("POST", `/api/admin/orders/${cust.orderId}/bill`, {}, staff)).status, 400);
  const mine = (await call("GET", "/api/orders", null, cust)).data;
  assert.equal(mine[0].status, "billed");
});

test("phone / counter bill is billed immediately and linked to the customer by phone", async () => {
  const dal = await stockOf("Dal");
  const r = await call("POST", "/api/admin/bills", { channel: "phone", phone: "9876543210", payment: "cash", discount: 10, items: [{ productId: 2, qty: 2 }] }, staff);
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "billed");
  assert.equal(r.data.customer_name, "Meena");
  assert.equal(r.data.total, 270);
  assert.equal(await stockOf("Dal"), dal - 2);
});

test("billing more than in stock is refused and changes nothing", async () => {
  const sugar = await stockOf("Sugar");
  const r = await call("POST", "/api/admin/bills", { channel: "counter", items: [{ productId: 4, qty: 1 }, { productId: 5, qty: 100000 }] }, staff);
  assert.equal(r.status, 400);
  assert.equal(await stockOf("Sugar"), sugar);
});

test("void restores stock; only admin may void", async () => {
  const before = await stockOf("Rice");
  assert.equal((await call("POST", `/api/admin/orders/${cust.orderId}/void`, { reason: "returned" }, staff)).status, 403);
  assert.equal((await call("POST", `/api/admin/orders/${cust.orderId}/void`, { reason: "returned" }, admin)).status, 200);
  assert.equal(await stockOf("Rice"), before + 2.5);
});

test("cancel pending order by customer", async () => {
  const o = await call("POST", "/api/orders", { address: "Pickup", items: [{ productId: 3, qty: 1 }] }, cust);
  assert.equal((await call("POST", `/api/orders/${o.data.id}/cancel`, {}, cust)).status, 200);
  assert.equal((await call("POST", `/api/admin/orders/${o.data.id}/bill`, {}, staff)).status, 400);
});

test("rejects non-JSON writes and bad input", async () => {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(r.status, 400);
  assert.equal((await call("POST", "/api/admin/bills", { items: [{ productId: 1, qty: -2 }] }, staff)).status, 400);
  assert.equal((await call("POST", "/api/signup", { name: "X", phone: "123", password: "abcdef" })).status, 400);
});
