const load = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};

const state = {
  query: "",
  products: load("products", DEFAULT_PRODUCTS),
  cart: load("cart", {}),
  dismissed: load("dismissed", {}) // product ids whose low-stock warning was closed
};

const $ = (id) => document.getElementById(id);
const findProduct = (id) => state.products.find((p) => p.id === +id);
const isLow = (p) => p.stock <= p.lowStock;

function save() {
  try {
    localStorage.setItem("products", JSON.stringify(state.products));
    localStorage.setItem("cart", JSON.stringify(state.cart));
    localStorage.setItem("dismissed", JSON.stringify(state.dismissed));
  } catch { /* storage unavailable (e.g. private window) — changes last for this visit only */ }
}

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = "✓ " + msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function render() {
  renderAlerts();
  renderLowStock();
  renderProducts();
  renderStock();
  renderCart();
}

function renderAlerts() {
  // A closed warning stays hidden until the product is restocked above its alert level
  for (const p of state.products) if (!isLow(p)) delete state.dismissed[p.id];
  const low = state.products.filter((p) => isLow(p) && !state.dismissed[p.id]);
  $("alerts").innerHTML = low
    .map((p) => `<div class="alert ${p.stock <= 0 ? "out" : ""}">
      <button class="close" data-dismiss="${p.id}" title="Close" aria-label="Close">×</button>
      ⚠️ <b>${p.name}</b> ${p.stock <= 0 ? "is OUT OF STOCK" : `is running low: only ${p.stock} ${p.unit} left`}
      (alert level: ${p.lowStock} ${p.unit})
    </div>`)
    .join("");
}

function renderLowStock() {
  const low = state.products.filter(isLow).sort((a, b) => a.stock / (a.lowStock || 1) - b.stock / (b.lowStock || 1));
  $("lowCount").textContent = low.length;
  $("lowRows").innerHTML = low.length
    ? low.map((p) => `
      <tr class="${p.stock <= 0 ? "out" : "low"}">
        <td>${p.emoji || "📦"} ${p.name}</td>
        <td>${p.stock} ${p.unit}</td>
        <td>${p.lowStock} ${p.unit}</td>
        <td>${p.stock <= 0 ? "❌ Out of stock" : "⚠️ Low"}</td>
        <td>
          <input type="number" min="0.1" step="any" placeholder="Qty" id="restock-${p.id}"> ${p.unit}
          <button data-restock="${p.id}">Add Stock</button>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="5">✅ All products are sufficiently stocked.</td></tr>`;
}

function renderProducts() {
  const q = state.query.toLowerCase();
  const list = state.products.filter((p) => p.name.toLowerCase().includes(q));
  $("products").innerHTML = list.length
    ? list.map((p) => {
        const left = p.stock - (state.cart[p.id] || 0);
        const status = p.stock <= 0 ? "out" : isLow(p) ? "low" : "ok";
        const label = { out: "Out of stock", low: "Low stock", ok: "In stock" }[status];
        return `<div class="card ${status}">
          <div class="card-media">
            <span class="emoji">${p.emoji || "📦"}</span>
            <span class="badge ${status}" ${status !== "ok" ? `data-tab="lowTab" title="View low stock products"` : ""}>${label}</span>
          </div>
          <div class="card-body">
            <h3>${p.name}</h3>
            <p class="price">₹${p.price}<span>/ ${p.unit}</span></p>
            <p class="stock">${p.stock} ${p.unit} available</p>
            <div class="qty-field">
              <label for="qty-${p.id}">Qty</label>
              <input type="number" id="qty-${p.id}" min="0.1" step="any" value="1" ${left <= 0 ? "disabled" : ""}>
              <span>${p.unit}</span>
            </div>
            <button class="add-btn" data-add="${p.id}" ${left <= 0 ? "disabled" : ""}>${p.stock <= 0 ? "Out of stock" : "Add to cart"}</button>
            ${state.cart[p.id] ? `<p class="in-cart">✓ ${state.cart[p.id]} ${p.unit} in cart</p>` : ""}
          </div>
        </div>`;
      }).join("")
    : "<p>No products found.</p>";
}

function renderStock() {
  $("stockRows").innerHTML = state.products.map((p) => `
    <tr class="${isLow(p) ? "low" : ""}">
      <td>${p.emoji || "📦"} ${p.name}</td>
      <td><input type="number" min="0" step="0.01" value="${p.price}" data-edit="price" data-id="${p.id}"></td>
      <td>${p.unit}</td>
      <td><input type="number" min="0" step="any" value="${p.stock}" data-edit="stock" data-id="${p.id}"></td>
      <td><input type="number" min="0" step="any" value="${p.lowStock}" data-edit="lowStock" data-id="${p.id}"></td>
      <td>${p.stock <= 0 ? "❌ Out" : isLow(p) ? "⚠️ Low" : "✅ OK"}</td>
      <td><button class="danger" data-remove="${p.id}">Remove</button></td>
    </tr>`).join("");
}

function renderCart() {
  let total = 0, count = 0;  // count = number of different products
  $("cartItems").innerHTML = Object.entries(state.cart).map(([id, qty]) => {
    const p = findProduct(id);
    if (!p) return "";
    total += p.price * qty;
    count += 1;
    return `<li class="cart-item">
      <div class="ci-emoji">${p.emoji || "📦"}</div>
      <div class="ci-info">
        <div class="ci-top">
          <strong>${p.name}</strong>
          <button class="ci-remove" data-delcart="${id}" aria-label="Remove ${p.name}" title="Remove">🗑</button>
        </div>
        <div class="ci-unit">₹${p.price} / ${p.unit}</div>
        <div class="ci-bottom">
          <div class="stepper">
            <button data-dec="${id}" aria-label="Decrease">−</button>
            <input type="number" class="cart-qty" min="0" step="any" value="${qty}" data-cartqty="${id}">
            <span class="ci-u">${p.unit}</span>
            <button data-inc="${id}" aria-label="Increase">+</button>
          </div>
          <span class="ci-price">₹${+(p.price * qty).toFixed(2)}</span>
        </div>
      </div>
    </li>`;
  }).join("") || `<li class="cart-empty"><div>🧺</div><p>Your cart is empty</p></li>`;
  $("cartTotal").textContent = +total.toFixed(2);
  $("cartCount").textContent = count;
}

function changeQty(id, delta) {
  setQty(id, (state.cart[id] || 0) + delta);
}

// Set the exact quantity of a product in the cart (0 removes it)
function setQty(id, qty) {
  const p = findProduct(id);
  qty = +(+qty).toFixed(3);
  if (isNaN(qty) || qty < 0) return render();
  if (qty > p.stock) {
    alert(`Only ${p.stock} ${p.unit} of ${p.name} available.`);
    return render();
  }
  if (qty === 0) delete state.cart[id];
  else state.cart[id] = qty;
  save();
  render();
}

document.addEventListener("click", (e) => {
  const d = (e.target.closest("[data-tab]") || e.target).dataset;
  if (d.add) {
    const qty = parseFloat($(`qty-${d.add}`).value);
    if (isNaN(qty) || qty <= 0) return alert("Enter a quantity greater than 0.");
    changeQty(d.add, qty);
  }
  if (d.inc) changeQty(d.inc, 1);
  if (d.dec) changeQty(d.dec, -1);
  if (d.delcart) setQty(d.delcart, 0);
  if (d.tab) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === d.tab));
    window.scrollTo({ top: 0, behavior: "smooth" });
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.toggle("hidden", c.id !== d.tab));
  }
  if (d.dismiss) {
    state.dismissed[d.dismiss] = true;
    save();
    renderAlerts();
  }
  if (d.restock) {
    const qty = parseFloat($(`restock-${d.restock}`).value);
    if (isNaN(qty) || qty <= 0) return alert("Enter a quantity greater than 0.");
    const p = findProduct(d.restock);
    p.stock = +(p.stock + qty).toFixed(3);
    save();
    render();
  }
  if (d.remove) {
    const p = findProduct(d.remove);
    if (!confirm(`Remove ${p.name}?`)) return;
    state.products = state.products.filter((x) => x.id !== p.id);
    delete state.cart[p.id];
    save();
    render();
  }
});

// Edit price / stock / low-stock level directly in the stock table
document.addEventListener("change", (e) => {
  const { edit, id, cartqty } = e.target.dataset;
  if (cartqty) return setQty(cartqty, parseFloat(e.target.value));
  if (!edit) return;
  const value = parseFloat(e.target.value);
  if (isNaN(value) || value < 0) return render();
  const p = findProduct(id);
  const old = p[edit];
  p[edit] = value;
  save();
  render();
  const label = { price: "Price", stock: "Available quantity", lowStock: "Low-stock alert level" }[edit];
  const fmt = (v) => (edit === "price" ? `₹${v}` : `${v} ${p.unit}`);
  toast(`${label} of ${p.name} updated: ${fmt(old)} → ${fmt(value)}`);
});

$("addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (state.products.some((p) => p.name.toLowerCase() === f.name.trim().toLowerCase()))
    return alert(`${f.name} already exists.`);
  state.products.push({
    id: Math.max(0, ...state.products.map((p) => p.id)) + 1,
    name: f.name.trim(),
    price: +f.price,
    unit: f.unit.trim(),
    stock: +f.stock,
    lowStock: +f.lowStock,
    emoji: f.emoji.trim() || "📦"
  });
  const name = f.name.trim();
  e.target.reset();
  save();
  render();
  alert(`${name} added. You can see it in the Shop and Stock Management tabs.`);
});

$("search").addEventListener("input", (e) => { state.query = e.target.value; renderProducts(); });
function setCartOpen(open) {
  $("cart").classList.toggle("hidden", !open);
  $("cartBackdrop").classList.toggle("hidden", !open);
}
$("cartBtn").onclick = () => setCartOpen($("cart").classList.contains("hidden"));
$("closeCart").onclick = () => setCartOpen(false);
$("continueShopping").onclick = () => setCartOpen(false);
$("cartBackdrop").onclick = () => setCartOpen(false);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setCartOpen(false); });

// Checkout reduces available stock
$("checkout").onclick = () => {
  if (!Object.keys(state.cart).length) return alert("Your cart is empty.");
  const total = $("cartTotal").textContent;
  for (const [id, qty] of Object.entries(state.cart)) {
    const p = findProduct(id);
    if (p) p.stock = Math.max(0, p.stock - qty);
  }
  state.cart = {};
  save();
  render();
  alert(`Order placed! Total: ₹${total}`);
};

render();
