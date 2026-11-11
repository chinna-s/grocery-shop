// Default products, loaded only the first time. After that, products are
// managed from the "Manage Stock" panel and saved in the browser (localStorage).
// stock = quantity available, lowStock = alert when stock falls to this level or below.
const DEFAULT_PRODUCTS = [
  { id: 1, name: "Rice",  price: 75,  unit: "kg", stock: 100, lowStock: 20, emoji: "🍚" },
  { id: 2, name: "Dal",   price: 140, unit: "kg", stock: 50,  lowStock: 10, emoji: "🫘" },
  { id: 3, name: "Wheat", price: 45,  unit: "kg", stock: 80,  lowStock: 15, emoji: "🌾" },
  { id: 4, name: "Sugar", price: 48,  unit: "kg", stock: 60,  lowStock: 10, emoji: "🧂" },
  { id: 5, name: "Maida", price: 50,  unit: "kg", stock: 40,  lowStock: 8,  emoji: "🥣" }
];
