import { $, esc, money, qtyText, when, api, toast, run, STATUS_LABEL, CHANNEL_LABEL } from "./common.js";

const S = {
  user: null, tab: "orders", products: [],
  ordFilter: "pending", ordQ: "",
  bill: freshBill(), recv: [{ productId: "", qty: "", costPrice: "" }], moveKind: ""
};
function freshBill() { return { channel: "counter", phone: "", name: "", address: "", items: {}, discount: "", payment: "cash", note: "", q: "" }; }

const isAdmin = () => S.user?.role === "admin";
const TABS = [
  { id: "orders", label: "Orders" },
  { id: "bill", label: "New Bill" },
  { id: "stock", label: "Stock" },
  { id: "products", label: "Products", admin: true },
  { id: "staff", label: "Staff", admin: true }
];
const prod = (id) => S.products.find((p) => p.id === +id);
const lowOrOut = (p) => p.stock <= p.lowStock;
const view = () => $("view");

// ------------------------------------------------------------ boot / login
function showLogin(msg = "") {
  S.user = null;
  $("app").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  $("loginError").textContent = msg;
}

async function boot() {
  let me;
  try { me = (await api("GET", "/api/me")).user; } catch (e) { return showLogin(e.message); }
  if (!me) return showLogin();
  if (me.role === "customer") {
    await api("POST", "/api/logout", {}).catch(() => {});
    return showLogin("That is a customer account. Please use a staff login.");
  }
  S.user = me;
  $("loginView").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("who").textContent = `${me.name} (${me.role})`;
  if (!TABS.find((t) => t.id === S.tab && (!t.admin || isAdmin()))) S.tab = "orders";
  await refreshProducts();
  renderTabs();
  go(S.tab);
  refreshSummary();
}

$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  await run(e.submitter, async () => {
    try { await api("POST", "/api/login", Object.fromEntries(new FormData(e.target))); e.target.reset(); await boot(); }
    catch (err) { $("loginError").textContent = err.message; }
  });
};
$("logoutBtn").onclick = async () => { await api("POST", "/api/logout", {}).catch(() => {}); showLogin(); };

// Any API call that comes back 401 sends the user to the login screen
async function call(method, url, body) {
  try { return await api(method, url, body); }
  catch (e) { if (e.status === 401) showLogin("Your session ended. Please log in again."); throw e; }
}

async function refreshProducts() { S.products = await call("GET", "/api/admin/products"); }

let summary = { pending: 0, low: 0, todaySales: 0, todayBills: 0 };
async function refreshSummary() {
  try { summary = await call("GET", "/api/admin/summary"); } catch { return; }
  $("kpis").innerHTML = `
    <div class="kpi">Today's sales<b>${money(summary.todaySales)}</b></div>
    <div class="kpi">Bills today<b>${summary.todayBills}</b></div>
    <div class="kpi ${summary.pending ? "alert" : ""}">Pending orders<b>${summary.pending}</b></div>
    <div class="kpi ${summary.low ? "alert" : ""}">Low / out of stock<b>${summary.low}</b></div>`;
  renderTabs();
}
setInterval(() => { if (S.user) refreshSummary(); }, 30000);

function renderTabs() {
  $("tabs").innerHTML = TABS.filter((t) => !t.admin || isAdmin()).map((t) => {
    const n = t.id === "orders" ? summary.pending : t.id === "stock" ? summary.low : 0;
    return `<button role="tab" class="${t.id === S.tab ? "active" : ""}" data-tab="${t.id}">${t.label}${n ? `<span class="count">${n}</span>` : ""}</button>`;
  }).join("");
}

function go(tab) {
  S.tab = tab;
  renderTabs();
  ({ orders: viewOrders, bill: viewBill, stock: viewStock, products: viewProducts, staff: viewStaff })[tab]();
}

// -------------------------------------------------------------------- orders
async function viewOrders() {
  const f = S.ordFilter;
  view().innerHTML = `
    <div class="filters">
      ${[["pending", "Pending"], ["billed", "Billed"], ["cancelled", "Cancelled"], ["", "All"]]
        .map(([v, l]) => `<button class="${f === v ? "on" : ""}" data-filter="${v}">${l}</button>`).join("")}
      <input id="ordQ" type="search" placeholder="Search name, phone or bill no." value="${esc(S.ordQ)}" class="grow">
    </div>
    <div id="orders" class="orders"><p class="empty-note">Loading…</p></div>`;
  loadOrders();
}

async function loadOrders() {
  let orders;
  try { orders = await call("GET", `/api/admin/orders?status=${S.ordFilter}&q=${encodeURIComponent(S.ordQ)}`); }
  catch (e) { return ($("orders").innerHTML = `<p class="empty-note">${esc(e.message)}</p>`); }
  if (!$("orders")) return;
  $("orders").innerHTML = orders.map(orderCard).join("") ||
    `<p class="empty-note">${S.ordFilter === "pending" ? "🎉 No pending orders." : "Nothing found."}</p>`;
}

function orderCard(o) {
  const pending = o.status === "pending";
  const lines = o.items.map((i) => {
    const p = prod(i.productId);
    const short = pending && p && i.qty > p.stock;
    return `<tr>
      <td>${esc(i.name)}${short ? `<br><span class="mv-out">only ${qtyText(p.stock)} in stock</span>` : ""}</td>
      <td>${pending ? `<input class="oqty" type="number" min="0" step="any" value="${qtyText(i.qty)}" data-pid="${i.productId}" aria-label="Quantity of ${esc(i.name)}"> ${esc(i.unit)}`
        : `${qtyText(i.qty)} ${esc(i.unit)}`}</td>
      <td class="num">${money(i.lineTotal)}</td></tr>`;
  }).join("");
  return `<article class="ocard ${o.status}" data-oid="${o.id}">
    <header><strong>#${o.id} · ${esc(o.customer_name)}</strong><span class="pill ${o.status}">${STATUS_LABEL[o.status]}</span></header>
    <div class="meta">${CHANNEL_LABEL[o.channel]} · ${when(o.created)}
      ${o.phone ? ` · <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>` : ""}</div>
    ${o.address ? `<div class="meta">📍 ${esc(o.address)}</div>` : ""}
    ${o.note ? `<div class="meta">📝 ${esc(o.note)}</div>` : ""}
    <table><thead><tr><th>Item</th><th>Qty</th><th class="num">Amount</th></tr></thead><tbody>${lines}</tbody></table>
    ${pending ? `<div class="actions">
        <label>Discount ₹ <input class="disc" type="number" min="0" step="any" value="${o.discount || ""}" placeholder="0"></label>
        <select class="pay" aria-label="Payment mode">${["cash", "upi", "card", "credit"].map((m) => `<option>${m}</option>`).join("")}</select>
      </div>
      <div class="bill-total"><span>Total</span><strong>${money(o.total)}</strong></div>
      <div class="actions">
        <button data-act="bill-order" data-id="${o.id}">✔ Bill &amp; reduce stock</button>
        <button class="danger" data-act="cancel-order" data-id="${o.id}">Cancel</button>
      </div>`
    : `<div class="bill-total"><span>${o.discount ? `Total (after ${money(o.discount)} discount)` : "Total"}${o.payment ? ` · ${esc(o.payment)}` : ""}</span><strong>${money(o.total)}</strong></div>
      <div class="actions">
        ${o.status === "billed" ? `<button class="secondary" data-act="receipt" data-id="${o.id}">🖨 Bill</button>` : ""}
        ${o.status === "billed" && isAdmin() ? `<button class="danger" data-act="void" data-id="${o.id}">Void bill</button>` : ""}
      </div>`}
  </article>`;
}

// ------------------------------------------------------------------ new bill
function viewBill() {
  const b = S.bill;
  view().innerHTML = `
  <div class="grid2">
    <section class="panel">
      <h2>1 · Customer</h2>
      <p class="muted">For a phone call, choose Phone and enter the caller's number. If they have a website account, their name fills in.</p>
      <div class="row center-y" style="margin-bottom:10px">
        <div class="seg" role="group" aria-label="Sale type">
          <button class="${b.channel === "counter" ? "on" : ""}" data-act="channel" data-v="counter">🏪 Counter</button>
          <button class="${b.channel === "phone" ? "on" : ""}" data-act="channel" data-v="phone">📞 Phone order</button>
        </div>
      </div>
      <div class="row">
        <label class="field grow sugg">Phone (optional)
          <input id="bPhone" value="${esc(b.phone)}" inputmode="tel" autocomplete="off" placeholder="Search by phone or name">
          <div id="suggest" class="sugg-list hidden"></div>
        </label>
        <label class="field grow">Customer name<input id="bName" value="${esc(b.name)}" maxlength="80" placeholder="Walk-in customer"></label>
      </div>
      ${b.channel === "phone" ? `<label class="field" style="margin-top:10px">Delivery address<input id="bAddress" value="${esc(b.address)}" maxlength="300"></label>` : ""}
      <h2 style="margin-top:18px">2 · Add items</h2>
      <input id="bSearch" type="search" value="${esc(b.q)}" placeholder="Search product…" style="width:100%">
      <div id="chips" class="chips"></div>
    </section>
    <section class="panel">
      <h2>3 · Bill</h2>
      <div id="billLines"></div>
    </section>
  </div>`;
  renderChips();
  renderBillLines();
}

function renderChips() {
  const q = S.bill.q.toLowerCase();
  $("chips").innerHTML = S.products.filter((p) => p.name.toLowerCase().includes(q)).map((p) =>
    `<button class="chip ${lowOrOut(p) ? "low" : ""}" data-act="add-line" data-id="${p.id}" ${p.stock <= 0 ? "disabled" : ""}>
      ${esc(p.emoji)} ${esc(p.name)}<small>${money(p.price)}/${esc(p.unit)} · ${p.stock <= 0 ? "out of stock" : qtyText(p.stock) + " left"}</small></button>`
  ).join("") || `<span class="muted">No product found</span>`;
}

function billTotals() {
  let sub = 0;
  for (const [id, q] of Object.entries(S.bill.items)) sub += (prod(id)?.price || 0) * q;
  const disc = Math.min(Math.max(+S.bill.discount || 0, 0), sub);
  return { sub, disc, total: sub - disc };
}

function renderBillLines() {
  const b = S.bill, ids = Object.keys(b.items);
  const t = billTotals();
  $("billLines").innerHTML = ids.length ? `
    <div class="tablewrap"><table>
      <thead><tr><th>Item</th><th>Qty</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>${ids.map((id) => {
        const p = prod(id), q = b.items[id];
        return `<tr class="${q > p.stock ? "out" : ""}"><td>${esc(p.emoji)} ${esc(p.name)}<br><small class="muted">${money(p.price)}/${esc(p.unit)}${q > p.stock ? ` · <b class="mv-out">only ${qtyText(p.stock)} in stock</b>` : ""}</small></td>
          <td><input type="number" min="0" step="any" value="${qtyText(q)}" data-act="line-qty" data-id="${id}" aria-label="Quantity of ${esc(p.name)}"> ${esc(p.unit)}</td>
          <td class="num">${money(p.price * q)}</td>
          <td><button class="danger" data-act="del-line" data-id="${id}" aria-label="Remove ${esc(p.name)}">✕</button></td></tr>`;
      }).join("")}</tbody></table></div>
    <div class="row" style="margin-top:10px">
      <label class="field grow">Discount ₹<input id="bDisc" type="number" min="0" step="any" value="${esc(b.discount)}" placeholder="0"></label>
      <label class="field grow">Payment
        <select id="bPay">${["cash", "upi", "card", "credit"].map((m) => `<option ${b.payment === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    </div>
    <div class="bill-total big"><span>Total</span><strong id="bTotal">${money(t.total)}</strong></div>
    <button class="bigbtn" data-act="make-bill">✔ Bill &amp; reduce stock</button>
    <button class="link" data-act="clear-bill" style="margin-top:8px">Clear</button>`
    : `<p class="empty-note">Tap products on the left to add them.</p>`;
}

async function saveBill(btn) {
  const b = S.bill;
  const items = Object.entries(b.items).filter(([, q]) => q > 0).map(([productId, qty]) => ({ productId: +productId, qty }));
  await run(btn, async () => {
    const o = await call("POST", "/api/admin/bills", {
      channel: b.channel, phone: b.phone, customerName: b.name, address: b.address,
      discount: +b.discount || 0, payment: b.payment, items
    });
    toast(`Bill #${o.id} done — stock updated`);
    S.bill = freshBill();
    await refreshProducts();
    viewBill();
    refreshSummary();
    showReceipt(o);
  });
}

let suggestTimer;
function suggest(q) {
  clearTimeout(suggestTimer);
  const box = $("suggest");
  if (q.length < 2) return box.classList.add("hidden");
  suggestTimer = setTimeout(async () => {
    try {
      const list = await call("GET", `/api/admin/customers?q=${encodeURIComponent(q)}`);
      if (!$("suggest")) return;
      box.innerHTML = list.map((c) => `<button type="button" data-act="pick-customer" data-name="${esc(c.name)}" data-phone="${esc(c.phone)}" data-address="${esc(c.address || "")}">${esc(c.name)} · ${esc(c.phone)}</button>`).join("");
      box.classList.toggle("hidden", !list.length);
    } catch { /* ignore */ }
  }, 250);
}

// --------------------------------------------------------------------- stock
async function viewStock() {
  await refreshProducts();
  const admin = isAdmin();
  const recv = S.recv.map((l, i) => `<tr>
      <td><select data-act="recv-field" data-i="${i}" data-f="productId" aria-label="Product">
        <option value="">Choose product…</option>${S.products.map((p) => `<option value="${p.id}" ${+l.productId === p.id ? "selected" : ""}>${esc(p.emoji)} ${esc(p.name)} (${esc(p.unit)})</option>`).join("")}</select></td>
      <td><input type="number" min="0" step="any" value="${esc(l.qty)}" data-act="recv-field" data-i="${i}" data-f="qty" placeholder="Qty received" aria-label="Quantity received"></td>
      <td><input type="number" min="0" step="any" value="${esc(l.costPrice)}" data-act="recv-field" data-i="${i}" data-f="costPrice" placeholder="optional" aria-label="Cost price per unit"></td>
      <td>${S.recv.length > 1 ? `<button class="danger" data-act="recv-del" data-i="${i}" aria-label="Remove line">✕</button>` : ""}</td></tr>`).join("");

  view().innerHTML = `
    ${admin ? `<section class="panel">
      <h2>📥 Goods received (stock in)</h2>
      <p class="muted">When a delivery arrives, enter what came in. Stock goes up immediately and the delivery is recorded below.</p>
      <div class="row">
        <label class="field grow">Supplier<input id="rSupplier" maxlength="100" placeholder="e.g. ABC Traders"></label>
        <label class="field grow">Note / invoice no.<input id="rNote" maxlength="200"></label>
      </div>
      <div class="tablewrap"><table><thead><tr><th>Product</th><th>Quantity</th><th>Cost ₹ / unit</th><th></th></tr></thead><tbody>${recv}</tbody></table></div>
      <div class="row" style="margin-top:10px">
        <button class="secondary" data-act="recv-add">+ Add another product</button>
        <button data-act="recv-save">✔ Add to stock</button>
      </div>
    </section>` : ""}
    <section class="panel">
      <h2>Current stock</h2>
      <p class="muted">Stock goes down only when an order is billed. ${admin ? "Use Correct for damage, spoilage or a recount." : ""}</p>
      <div class="tablewrap"><table>
        <thead><tr><th>Product</th><th class="num">In stock</th><th class="num">Alert at</th><th>Status</th>${admin ? "<th></th>" : ""}</tr></thead>
        <tbody>${S.products.map((p) => `<tr class="${p.stock <= 0 ? "out" : lowOrOut(p) ? "low" : ""}">
          <td>${esc(p.emoji)} ${esc(p.name)}</td><td class="num"><b>${qtyText(p.stock)}</b> ${esc(p.unit)}</td>
          <td class="num">${qtyText(p.lowStock)} ${esc(p.unit)}</td>
          <td>${p.stock <= 0 ? "❌ Out of stock" : lowOrOut(p) ? "⚠️ Low — reorder" : "✅ OK"}</td>
          ${admin ? `<td><button class="secondary" data-act="adjust" data-id="${p.id}">Correct</button></td>` : ""}</tr>`).join("")}</tbody></table></div>
    </section>
    ${admin ? `<section class="panel"><h2>Stock history</h2>
      <div class="filters">${[["", "All"], ["in", "Goods in"], ["sale", "Sales"], ["adjust", "Corrections"]]
        .map(([v, l]) => `<button class="${S.moveKind === v ? "on" : ""}" data-act="move-kind" data-v="${v}">${l}</button>`).join("")}</div>
      <div id="moves" class="tablewrap"><p class="empty-note">Loading…</p></div></section>` : ""}`;
  if (admin) loadMoves();
}

async function loadMoves() {
  try {
    const moves = await call("GET", `/api/admin/stock-moves?kind=${S.moveKind}`);
    if (!$("moves")) return;
    const label = { in: "Goods in", sale: "Sale", adjust: "Correction" };
    $("moves").innerHTML = moves.length ? `<table><thead><tr><th>When</th><th>Type</th><th>Product</th><th class="num">Qty</th><th>Details</th><th>By</th></tr></thead><tbody>
      ${moves.map((m) => `<tr><td>${when(m.created)}</td><td>${label[m.kind]}</td><td>${esc(m.product)}</td>
        <td class="num ${m.qty > 0 ? "mv-in" : "mv-out"}">${m.qty > 0 ? "+" : ""}${qtyText(m.qty)} ${esc(m.unit)}</td>
        <td>${[m.supplier, m.costPrice != null ? `cost ${money(m.costPrice)}` : "", m.refOrder ? `bill #${m.refOrder}` : "", m.note].filter(Boolean).map(esc).join(" · ")}</td>
        <td>${esc(m.by || "")}</td></tr>`).join("")}</tbody></table>` : `<p class="empty-note">No movements yet.</p>`;
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------------ products
async function viewProducts() {
  await refreshProducts();
  view().innerHTML = `
    <section class="panel"><h2>Add a new product</h2>
      <form id="newProd" class="row">
        <label class="field" style="width:70px">Icon<input name="emoji" maxlength="8" placeholder="🥜"></label>
        <label class="field grow">Name<input name="name" required maxlength="60"></label>
        <label class="field" style="width:100px">Price ₹<input name="price" type="number" min="0" step="0.01" required></label>
        <label class="field" style="width:90px">Unit<input name="unit" value="kg" required maxlength="12"></label>
        <label class="field" style="width:110px">Opening stock<input name="stock" type="number" min="0" step="any" value="0"></label>
        <label class="field" style="width:110px">Alert at<input name="lowStock" type="number" min="0" step="any" value="5" required></label>
        <button type="submit">Add product</button>
      </form></section>
    <section class="panel"><h2>Products &amp; prices</h2>
      <p class="muted">Change a price or alert level, then press Save on that row. Stock quantity is changed from the Stock tab so every change is recorded.</p>
      <div class="tablewrap"><table><thead><tr><th>Icon</th><th>Name</th><th>Price ₹</th><th>Unit</th><th>Alert at</th><th class="num">In stock</th><th></th></tr></thead>
      <tbody>${S.products.map((p) => `<tr data-pid="${p.id}">
        <td><input data-f="emoji" value="${esc(p.emoji)}" maxlength="8" style="width:56px" aria-label="Icon"></td>
        <td><input data-f="name" class="name" value="${esc(p.name)}" maxlength="60" aria-label="Name"></td>
        <td><input data-f="price" type="number" min="0" step="0.01" value="${p.price}" aria-label="Price"></td>
        <td><input data-f="unit" value="${esc(p.unit)}" maxlength="12" style="width:70px" aria-label="Unit"></td>
        <td><input data-f="lowStock" type="number" min="0" step="any" value="${p.lowStock}" aria-label="Low stock alert"></td>
        <td class="num">${qtyText(p.stock)}</td>
        <td><button data-act="save-prod" data-id="${p.id}">Save</button> <button class="danger" data-act="del-prod" data-id="${p.id}">Remove</button></td></tr>`).join("")}</tbody></table></div>
    </section>`;
}

// --------------------------------------------------------------------- staff
async function viewStaff() {
  let users = [];
  try { users = await call("GET", "/api/admin/users"); } catch (e) { toast(e.message, true); }
  view().innerHTML = `
    <section class="panel"><h2>Add a staff member</h2>
      <p class="muted">Staff can take orders and bill. They cannot change stock, prices or products.</p>
      <form id="newStaff" class="row">
        <label class="field grow">Name<input name="name" required maxlength="80"></label>
        <label class="field grow">Username<input name="username" required maxlength="30" autocomplete="off"></label>
        <label class="field grow">Password (min 6)<input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
        <button type="submit">Add staff</button>
      </form></section>
    <section class="panel"><h2>Team</h2><div class="tablewrap"><table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${u.role}</td>
        <td>${u.active ? "Active" : "Disabled"}</td>
        <td>${u.id === S.user.id ? "<span class='muted'>(you)</span>" : `
          <button class="secondary" data-act="staff-active" data-id="${u.id}" data-v="${u.active ? 0 : 1}">${u.active ? "Disable" : "Enable"}</button>
          <button class="secondary" data-act="staff-pw" data-id="${u.id}">Reset password</button>`}</td></tr>`).join("")}</tbody></table></div></section>`;
}

// ------------------------------------------------------------------- receipt
function showReceipt(o) {
  $("receipt").innerHTML = `<div class="receipt">
    <h2>🛒 Fresh Mart</h2><p class="c">Bill #${o.id} · ${when(o.billed_at || o.created)}</p><hr>
    <div>${esc(o.customer_name)}${o.phone ? ` · ${esc(o.phone)}` : ""}</div>
    ${o.address ? `<div>${esc(o.address)}</div>` : ""}<hr>
    <table style="width:100%"><tbody>${o.items.map((i) => `<tr><td>${esc(i.name)}<br>${qtyText(i.qty)} ${esc(i.unit)} × ${money(i.price)}</td><td class="num">${money(i.lineTotal)}</td></tr>`).join("")}</tbody></table><hr>
    ${o.discount ? `<div class="tot"><span>Discount</span><span>−${money(o.discount)}</span></div>` : ""}
    <div class="tot"><span>TOTAL</span><span>${money(o.total)}</span></div>
    <p class="c">Paid by ${esc(o.payment || "cash")}<br>Thank you! Visit again.</p></div>`;
  $("receiptModal").classList.remove("hidden");
}
const hideReceipt = () => $("receiptModal").classList.add("hidden");
$("receiptClose").onclick = $("receiptDone").onclick = hideReceipt;
$("printBtn").onclick = () => window.print();
$("receiptModal").addEventListener("mousedown", (e) => { if (e.target === $("receiptModal")) hideReceipt(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideReceipt(); });

// ------------------------------------------------------------------- events
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return $("suggest")?.classList.add("hidden");
  const d = t.dataset;
  if (d.tab) return go(d.tab);
  if (d.filter !== undefined) { S.ordFilter = d.filter; return viewOrders(); }
  const id = d.id;
  switch (d.act) {
    case "bill-order": case "cancel-order": {
      const card = t.closest(".ocard");
      if (d.act === "cancel-order") {
        if (!confirm(`Cancel order #${id}?`)) return;
        return run(t, async () => { await call("POST", `/api/admin/orders/${id}/cancel`, {}); toast("Order cancelled"); loadOrders(); refreshSummary(); });
      }
      const items = [...card.querySelectorAll(".oqty")].map((i) => ({ productId: +i.dataset.pid, qty: parseFloat(i.value) })).filter((i) => i.qty > 0);
      if (!items.length) return toast("Nothing left to bill — cancel the order instead", true);
      return run(t, async () => {
        const o = await call("POST", `/api/admin/orders/${id}/bill`, { items, discount: parseFloat(card.querySelector(".disc").value) || 0, payment: card.querySelector(".pay").value });
        toast(`Bill #${o.id} done — stock updated`);
        await refreshProducts(); loadOrders(); refreshSummary(); showReceipt(o);
      });
    }
    case "receipt": {
      const o = (await call("GET", `/api/admin/orders?q=${id}`)).find((x) => x.id === +id);
      return o && showReceipt(o);
    }
    case "void": {
      const reason = prompt(`Void bill #${id}? The goods go back into stock.\n\nReason:`);
      if (reason === null) return;
      return run(t, async () => { await call("POST", `/api/admin/orders/${id}/void`, { reason }); toast("Bill voided, stock restored"); await refreshProducts(); loadOrders(); refreshSummary(); });
    }
    // new bill
    case "channel": S.bill.channel = d.v; return viewBill();
    case "add-line": {
      const p = prod(id), cur = S.bill.items[id] || 0;
      if (cur + 1 > p.stock) return toast(`Only ${qtyText(p.stock)} ${p.unit} of ${p.name} in stock`, true);
      S.bill.items[id] = cur + 1;
      return renderBillLines();
    }
    case "del-line": delete S.bill.items[id]; return renderBillLines();
    case "clear-bill": S.bill = freshBill(); return viewBill();
    case "make-bill": return saveBill(t);
    case "pick-customer":
      Object.assign(S.bill, { phone: d.phone, name: d.name, address: S.bill.address || d.address });
      return viewBill();
    // stock
    case "recv-add": S.recv.push({ productId: "", qty: "", costPrice: "" }); return viewStock();
    case "recv-del": S.recv.splice(+d.i, 1); return viewStock();
    case "recv-save": {
      const items = S.recv.filter((l) => l.productId || l.qty).map((l) => ({ productId: +l.productId, qty: parseFloat(l.qty), costPrice: l.costPrice === "" ? null : parseFloat(l.costPrice) }));
      if (!items.length || items.some((l) => !l.productId || !(l.qty > 0))) return toast("Choose a product and quantity on every line", true);
      return run(t, async () => {
        await call("POST", "/api/admin/stock-in", { supplier: $("rSupplier").value, note: $("rNote").value, items });
        toast("Stock updated");
        S.recv = [{ productId: "", qty: "", costPrice: "" }];
        viewStock(); refreshSummary();
      });
    }
    case "adjust": {
      const p = prod(id);
      const v = prompt(`Correct stock of ${p.name}.\nSystem says ${qtyText(p.stock)} ${p.unit}. Counted quantity:`, qtyText(p.stock));
      if (v === null) return;
      const reason = prompt("Reason (e.g. damaged, spoiled, recount):");
      if (!reason) return toast("A reason is required", true);
      return run(t, async () => { await call("POST", "/api/admin/stock-adjust", { productId: p.id, newStock: parseFloat(v), reason }); toast("Stock corrected"); viewStock(); refreshSummary(); });
    }
    case "move-kind": S.moveKind = d.v; return viewStock();
    // products
    case "save-prod": {
      const row = t.closest("tr"), f = (k) => row.querySelector(`[data-f=${k}]`).value;
      return run(t, async () => {
        await call("PUT", `/api/admin/products/${id}`, { emoji: f("emoji"), name: f("name"), price: parseFloat(f("price")), unit: f("unit"), lowStock: parseFloat(f("lowStock")) });
        toast("Product saved"); await refreshProducts(); refreshSummary();
      });
    }
    case "del-prod": {
      const p = prod(id);
      if (!confirm(`Remove ${p.name} from the shop? Old bills keep their record.`)) return;
      return run(t, async () => { await call("DELETE", `/api/admin/products/${id}`); toast("Product removed"); viewProducts(); refreshSummary(); });
    }
    // staff
    case "staff-active": return run(t, async () => { await call("PUT", `/api/admin/users/${id}`, { active: d.v === "1" }); viewStaff(); });
    case "staff-pw": {
      const pw = prompt("New password (min 6 characters):");
      if (!pw) return;
      return run(t, async () => { await call("PUT", `/api/admin/users/${id}`, { password: pw }); toast("Password changed"); });
    }
  }
});

document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "ordQ") { S.ordQ = t.value; clearTimeout(t._t); t._t = setTimeout(loadOrders, 300); }
  if (t.id === "bSearch") { S.bill.q = t.value; renderChips(); }
  if (t.id === "bPhone") { S.bill.phone = t.value; suggest(t.value.trim()); }
  if (t.id === "bName") S.bill.name = t.value;
  if (t.id === "bAddress") S.bill.address = t.value;
  if (t.id === "bDisc") { S.bill.discount = t.value; $("bTotal").textContent = money(billTotals().total); }
  if (t.id === "bPay") S.bill.payment = t.value;
  if (t.dataset.act === "recv-field") S.recv[+t.dataset.i][t.dataset.f] = t.value;
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "bPay") S.bill.payment = t.value;
  if (t.dataset.act === "line-qty") {
    const p = prod(t.dataset.id), q = parseFloat(t.value);
    if (!(q > 0)) delete S.bill.items[t.dataset.id];
    else S.bill.items[t.dataset.id] = +q.toFixed(3);
    if (p && q > p.stock) toast(`Only ${qtyText(p.stock)} ${p.unit} of ${p.name} in stock`, true);
    renderBillLines();
  }
  if (t.dataset.act === "recv-field") S.recv[+t.dataset.i][t.dataset.f] = t.value;
});

document.addEventListener("submit", async (e) => {
  if (e.target.id === "newProd") {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    await run(e.submitter, async () => {
      await call("POST", "/api/admin/products", { ...f, price: +f.price, stock: +f.stock, lowStock: +f.lowStock });
      toast(`${f.name} added`); viewProducts(); refreshSummary();
    });
  }
  if (e.target.id === "newStaff") {
    e.preventDefault();
    await run(e.submitter, async () => {
      await call("POST", "/api/admin/users", Object.fromEntries(new FormData(e.target)));
      toast("Staff member added"); viewStaff();
    });
  }
});

boot();
