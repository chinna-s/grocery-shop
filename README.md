# Fresh Mart – Grocery Shop

A simple, dependency-free grocery shop web app.

## Features
- 5 starting products: Rice, Dal, Wheat, Sugar, Maida
- **Manage Stock** panel:
  - See the quantity available for every product
  - Edit price, available quantity, and the low-stock alert level for each product
  - Add new products, or remove existing ones
- **Low-stock alerts** are shown at the top of the page when a product's quantity
  reaches its alert level or below (red when it's out of stock)
- Cart with quantity controls (you can't add more than is in stock)
- Checkout reduces the available stock
- Products, stock and cart are saved in the browser (localStorage)

## Run
Open `index.html` in a browser, or run:

    python3 -m http.server 8000

Then visit http://localhost:8000.

To go back to the default 5 products, clear the site data in your browser
(or run `localStorage.clear()` in the browser console) and reload.
