# Fresh Mart – Grocery Shop

Three jobs, kept separate:

| Job | Who | Where |
|---|---|---|
| **Receive goods** (stock in) | Owner (admin) | `/admin` → **Stock** |
| **Billing** (stock goes out) | Staff or owner | `/admin` → **Orders** and **New Bill** |
| **Ordering** | Customers, from phone or computer | `/` (the website, with login) |

Stock goes **up** only when the owner records goods received, and goes **down** only
when a bill is made. A customer placing an order does not change stock until the shop
packs and bills it.

## Run

Needs Node 22.13 or newer. There is nothing to install.

    npm start

Open http://localhost:3000 (customers) or http://localhost:3000/admin (shop panel).

On the first run the server creates an `admin` account and prints its password in the
terminal. To choose your own: `ADMIN_PASSWORD=yourpassword npm start`.
Data is kept in `data/shop.db` (SQLite). Back up that file to back up the shop.

Options: `PORT` (default 3000), `DATA_DIR`, `ADMIN_PASSWORD`, `COOKIE_SECURE=1` (set when served over https).

## How it works

**Customers** sign up with a phone number and password, add items to the cart, and place
an order with a delivery address (or "Pickup"). They can see and cancel their pending orders.
They pay on delivery or pickup.

**Orders (staff)**: online orders arrive as *Pending*. Staff can change quantities, add a
discount, choose the payment mode, and press **Bill & reduce stock**. Billing is refused if
there isn't enough stock. A printable bill is shown.

**New Bill (staff)**: for counter sales and phone orders. Choose *Counter* or *Phone*, search
the caller by number (a website customer's name fills in), tap products, bill.

**Stock (owner)**: record a delivery with supplier, quantity and cost. **Correct** fixes the
count after damage or a recount (a reason is required). Every change is kept in the stock history.

**Products (owner)**: add products, change price, unit and low-stock alert level. Removing a
product hides it; old bills keep their record.

**Staff (owner)**: add staff logins (can order and bill, cannot change stock or prices),
disable them, reset passwords. The owner can also **void** a bill, which returns the goods to stock.

## Security notes

- Passwords are hashed (scrypt); sessions use HttpOnly cookies; login attempts are rate limited.
- Roles are enforced on the server for every request, not just hidden in the page.
- Put the app behind HTTPS (for example a reverse proxy) before exposing it to the internet,
  and set `COOKIE_SECURE=1`.

## Tests

    npm test

Starts the real server on a temporary database and checks logins, roles, goods-in, online
orders, billing, stock deduction, voiding and bad input.
