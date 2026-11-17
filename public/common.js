// Shared helpers for the shop and admin pages
export const $ = (id) => document.getElementById(id);

// Escape text before putting it in innerHTML (names and notes come from users)
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const money = (n) => "₹" + (+(+n).toFixed(2)).toLocaleString("en-IN");
export const qtyText = (n) => +(+n).toFixed(3);
export const when = (s) => (s ? new Date(s.replace(" ", "T") + "Z").toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong");
    err.status = res.status;
    throw err;
  }
  return data;
}

export function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.setAttribute("role", isError ? "alert" : "status");
  el.textContent = (isError ? "⚠ " : "✓ ") + msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 5000 : 3000);
}

// Run an async action; show errors as a toast. Disables the button meanwhile.
export async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { if (btn) btn.disabled = false; }
}

export const STATUS_LABEL = { pending: "Pending", billed: "Billed", cancelled: "Cancelled" };
export const CHANNEL_LABEL = { online: "🌐 Website", phone: "📞 Phone", counter: "🏪 Counter" };
