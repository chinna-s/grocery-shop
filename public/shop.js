import { $, esc, money, qtyText, when, api, toast, run, STATUS_LABEL } from "./common.js";

const state = { products: [], cart: {}, user: null, query: "" };
try { state.cart = JSON.parse(localStorage.getItem("cart")) || {}; } catch { /* no storage */ }
const saveCart = () => { try { localStorage.setItem("cart", JSON.stringify(state.cart)); } catch { /* ignore */ } };
const product = (id) => state.products.find((p) => p.id === +id);
const STATUS_TEXT = { ok: "In stock", low: "Few left", out: "Out of stock" };

// ---------------------------------------------------------------- products
function renderProducts() {
  const q = state.query.toLowerCase();
  const list = state.products.filter((p) => p.name.toLowerCase().includes(q));
  $("products").innerHTML = list.length ? list.map((p) => {
    const out = p.status === "out";
    return `<div class="card ${p.status}">
      <div class="card-media"><span aria-hidden="true">${esc(p.emoji)}</span><span class="pill ${p.status}">${STATUS_TEXT[p.status]}</span></div>
      <div class="card-body">
        <h3>${esc(p.name)}</h3>
        <p class="price">${money(p.price)}<span>/ ${esc(p.unit)}</span></p>
        <div class="qty-field">
          <label for="qty-${p.id}">Qty</label>
          <input type="number" id="qty-${p.id}" min="0.1" step="any" value="1" ${out ? "disabled" : ""}>
          <span>${esc(p.unit)}</span>
        </div>
        <button class="add-btn" data-add="${p.id}" ${out ? "disabled" : ""}>${out ? "Out of stock" : "Add to cart"}</button>
        ${state.cart[p.id] ? `<p class="in-cart">✓ ${qtyText(state.cart[p.id])} ${esc(p.unit)} in cart</p>` : ""}
      </div></div>`;
  }).join("") : `<p>${state.products.length ? "No products found." : "Loading…"}</p>`;
}

// -------------------------------------------------------------------- cart
function cartLines() {
  return Object.entries(state.cart).map(([id, qty]) => ({ p: product(id), qty })).filter((l) => l.p);
}

function renderCart() {
  const lines = cartLines();
  let total = 0;
  $("cartItems").innerHTML = lines.map(({ p, qty }) => {
    total += p.price * qty;
    return `<li class="cart-item">
      <div class="ci-emoji">${esc(p.emoji)}</div>
      <div class="ci-info">
        <div class="ci-top"><strong>${esc(p.name)}</strong>
          <button class="ci-remove" data-del="${p.id}" aria-label="Remove ${esc(p.name)}" title="Remove">🗑</button></div>
        <div class="muted small">${money(p.price)} / ${esc(p.unit)}</div>
        <div class="ci-bottom">
          <div class="stepper">
            <button data-dec="${p.id}" aria-label="Decrease">−</button>
            <input type="number" min="0" step="any" value="${qtyText(qty)}" data-setqty="${p.id}" aria-label="Quantity in ${esc(p.unit)}">
            <button data-inc="${p.id}" aria-label="Increase">+</button>
          </div>
          <span class="ci-price">${money(p.price * qty)}</span>
        </div>
      </div></li>`;
  }).join("") || `<li class="empty"><div>🧺</div><p>Your cart is empty</p></li>`;
  $("cartTotal").textContent = money(total);
  $("cartCount").textContent = lines.length;
  $("placeOrder").disabled = !lines.length;
  $("checkoutFields").classList.toggle("hidden", !(lines.length && state.user?.role === "customer"));
  $("placeOrder").textContent = state.user?.role === "customer" ? "Place order" : "Log in to place order";
}

function setQty(id, qty) {
  const p = product(id);
  qty = +(+qty).toFixed(3);
  if (!p || isNaN(qty) || qty < 0) return render();
  if (qty > p.available) {
    toast(`Only ${qtyText(p.available)} ${p.unit} of ${p.name} available`, true);
    qty = p.available;
  }
  if (qty <= 0) delete state.cart[id]; else state.cart[id] = qty;
  saveCart();
  render();
}

function render() { renderProducts(); renderCart(); renderAccountBtn(); }

// ----------------------------------------------------------------- drawers
const drawers = ["cart", "account"];
function openDrawer(name) {
  drawers.forEach((d) => $(d).classList.toggle("hidden", d !== name));
  $("backdrop").classList.toggle("hidden", !name);
  if (name) $(name).querySelector("[data-close]").focus();
}
const closeAll = () => openDrawer(null);

// --------------------------------------------------------------------- auth
function renderAccountBtn() {
  const u = state.user;
  $("accountBtn").textContent = !u ? "Login / Sign up" : u.role === "customer" ? `👤 ${u.name.split(" ")[0]}` : "Staff panel →";
}

function showAuth(mode = "login") {
  $("loginForm").classList.toggle("hidden", mode !== "login");
  $("signupForm").classList.toggle("hidden", mode !== "signup");
  $("authTitle").textContent = mode === "login" ? "Log in" : "Create your account";
  $("loginError").textContent = $("signupError").textContent = "";
  $("authModal").classList.remove("hidden");
  (mode === "login" ? $("loginForm") : $("signupForm")).elements[0].focus();
}
const hideAuth = () => $("authModal").classList.add("hidden");

async function afterLogin(user, resumeCheckout) {
  state.user = user;
  hideAuth();
  if (user.role !== "customer") { location.href = "/admin"; return; }
  if (user.address && !$("address").value) $("address").value = user.address;
  toast(`Welcome, ${user.name.split(" ")[0]}!`);
  render();
  if (resumeCheckout) openDrawer("cart");
}

let resume = false;
$("toSignup").onclick = () => showAuth("signup");
$("toLogin").onclick = () => showAuth("login");
document.querySelector("[data-close-auth]").onclick = hideAuth;
$("authModal").addEventListener("mousedown", (e) => { if (e.target === $("authModal")) hideAuth(); });

$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $("loginError").textContent = "";
  await run(e.submitter, async () => {
    try { await afterLogin((await api("POST", "/api/login", f)).user, resume); e.target.reset(); }
    catch (err) { $("loginError").textContent = err.message; }
  });
};
$("signupForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $("signupError").textContent = "";
  await run(e.submitter, async () => {
    try { await afterLogin((await api("POST", "/api/signup", f)).user, resume); e.target.reset(); }
    catch (err) { $("signupError").textContent = err.message; }
  });
};

$("accountBtn").onclick = () => {
  if (!state.user) { resume = false; return showAuth("login"); }
  if (state.user.role !== "customer") { location.href = "/admin"; return; }
  openDrawer("account");
  loadOrders();
};

$("logoutBtn").onclick = async () => {
  await run($("logoutBtn"), async () => {
    await api("POST", "/api/logout", {});
    state.user = null;
    closeAll();
    render();
    toast("Logged out");
  });
};

// ------------------------------------------------------------------- orders
async function loadOrders() {
  $("orderList").innerHTML = `<li class="empty muted">Loading…</li>`;
  try {
    const orders = await api("GET", "/api/orders");
    $("orderList").innerHTML = orders.map((o) => `<li class="order">
      <div class="order-head"><strong>Order #${o.id}</strong><span class="pill ${o.status}">${STATUS_LABEL[o.status]}</span></div>
      <ul>${o.items.map((i) => `<li>${esc(i.name)} — ${qtyText(i.qty)} ${esc(i.unit)} (${money(i.lineTotal)})</li>`).join("")}</ul>
      <div><strong>Total ${money(o.total)}</strong>${o.discount ? ` <span class="muted">(after ${money(o.discount)} discount)</span>` : ""}</div>
      <div class="meta">${when(o.created)}${o.status === "pending" ? " · waiting for the shop to pack and bill it" : ""}</div>
      ${o.status === "pending" ? `<button class="secondary" data-cancel="${o.id}">Cancel order</button>` : ""}
    </li>`).join("") || `<li class="empty"><div>📦</div><p>No orders yet</p></li>`;
  } catch (e) {
    $("orderList").innerHTML = `<li class="empty">${esc(e.message)}</li>`;
  }
}

$("placeOrder").onclick = async () => {
  if (state.user?.role !== "customer") { resume = true; closeAll(); return showAuth("login"); }
  const items = cartLines().map(({ p, qty }) => ({ productId: p.id, qty }));
  const address = $("address").value.trim();
  if (!address) { $("address").focus(); return toast('Enter your delivery address, or write "Pickup"', true); }
  await run($("placeOrder"), async () => {
    try {
      const o = await api("POST", "/api/orders", { items, address, note: $("note").value });
      state.cart = {}; saveCart(); $("note").value = "";
      await loadProducts();
      render();
      openDrawer("account");
      loadOrders();
      toast(`Order #${o.id} placed! We'll bill it after packing.`);
    } catch (e) {
      toast(e.message, true);
      await loadProducts();   // stock may have changed
      render();
    }
  });
};

// ----------------------------------------------------------------- wiring
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.add) {
    const qty = parseFloat($(`qty-${d.add}`).value);
    if (!(qty > 0)) return toast("Enter a quantity greater than 0", true);
    const already = state.cart[d.add] || 0;
    setQty(d.add, already + qty);
    if (state.cart[d.add] !== undefined) toast(`${product(d.add).name} added to cart`);
  }
  if (d.inc) setQty(d.inc, (state.cart[d.inc] || 0) + 1);
  if (d.dec) setQty(d.dec, (state.cart[d.dec] || 0) - 1);
  if (d.del) setQty(d.del, 0);
  if (d.cancel && confirm(`Cancel order #${d.cancel}?`)) {
    await run(t, async () => { await api("POST", `/api/orders/${d.cancel}/cancel`, {}); toast("Order cancelled"); loadOrders(); });
  }
  if ("close" in d) closeAll();
});
document.addEventListener("change", (e) => { if (e.target.dataset.setqty) setQty(e.target.dataset.setqty, parseFloat(e.target.value)); });
$("cartBtn").onclick = () => openDrawer($("cart").classList.contains("hidden") ? "cart" : null);
$("backdrop").onclick = closeAll;
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("authModal").classList.contains("hidden")) hideAuth(); else closeAll();
});
$("search").addEventListener("input", (e) => { state.query = e.target.value; renderProducts(); });

// ---------------------------------------------------------------------- init
async function loadProducts() {
  state.products = await api("GET", "/api/products");
  // drop cart items that no longer exist or exceed stock
  for (const id of Object.keys(state.cart)) {
    const p = product(id);
    if (!p || p.available <= 0) delete state.cart[id];
    else if (state.cart[id] > p.available) state.cart[id] = p.available;
  }
  saveCart();
}

(async function init() {
  try {
    const [me] = await Promise.all([api("GET", "/api/me"), loadProducts()]);
    state.user = me.user;
    if (state.user?.address) $("address").value = state.user.address;
  } catch (e) {
    $("products").innerHTML = `<p>${esc(e.message)}</p>`;
    return;
  }
  render();
  setInterval(() => {
    if (document.activeElement?.closest("#products")) return;   // don't wipe a quantity being typed
    loadProducts().then(render).catch(() => {});
  }, 60000);
})();
