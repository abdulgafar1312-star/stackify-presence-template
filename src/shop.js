// Stackify storefront.
//
// Talks only to /api/shop/*, which is proxied by a Netlify Edge Function that
// holds the site credential. No secret ever reaches this file.
//
// The cart lives in localStorage. Prices shown here are for display; the
// authoritative total is computed server-side at checkout and is what the
// customer is charged.

const CART_KEY = "stackify.cart";
const CURRENCY_FALLBACK = "GHS";

const state = {
	catalogue: [],
	cart: loadCart(),
};

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------
function loadCart() {
	try {
		const raw = JSON.parse(localStorage.getItem(CART_KEY) ?? "[]");
		return Array.isArray(raw) ? raw : [];
	} catch {
		return [];
	}
}

function saveCart() {
	try {
		localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
	} catch {
		/* private mode: cart stays in memory for this page view */
	}
}

function cartLines() {
	return state.cart
		.map((entry) => {
			const product = state.catalogue.find((p) => p.id === entry.product);
			return product ? { product, qty: entry.qty } : null;
		})
		.filter(Boolean);
}

function cartTotal() {
	return cartLines().reduce((sum, line) => sum + line.product.price * line.qty, 0);
}

function addToCart(id, qty = 1) {
	const existing = state.cart.find((e) => e.product === id);
	if (existing) existing.qty += qty;
	else state.cart.push({ product: id, qty });
	saveCart();
	renderCart();
}

function setQty(id, qty) {
	const entry = state.cart.find((e) => e.product === id);
	if (!entry) return;
	if (qty <= 0) state.cart = state.cart.filter((e) => e.product !== id);
	else entry.qty = qty;
	saveCart();
	renderCart();
}

function removeFromCart(id) {
	state.cart = state.cart.filter((e) => e.product !== id);
	saveCart();
	renderCart();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function money(amount, currency) {
	const value = Number(amount ?? 0);
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency: currency || CURRENCY_FALLBACK,
		}).format(value);
	} catch {
		return `${(currency || CURRENCY_FALLBACK)} ${value.toFixed(2)}`;
	}
}

function renderProducts() {
	const grid = $("product-grid");
	grid.textContent = "";

	if (!state.catalogue.length) {
		$("shop-status").textContent = "No products are available right now.";
		return;
	}
	$("shop-status").textContent = `${state.catalogue.length} product(s) available.`;

	const currency = state.catalogue[0].currency;
	for (const product of state.catalogue) {
		const card = document.createElement("article");
		card.className = "card product";

		const title = document.createElement("h3");
		title.textContent = product.name;
		card.append(title);

		if (product.description) {
			const body = document.createElement("p");
			body.textContent = product.description;
			card.append(body);
		}

		const price = document.createElement("p");
		price.className = "price";
		price.textContent = money(product.price, product.currency || currency);
		if (product.compare_at_price > product.price) {
			const was = document.createElement("s");
			was.className = "muted";
			was.textContent = ` ${money(product.compare_at_price, product.currency || currency)}`;
			price.append(was);
		}
		card.append(price);

		const button = document.createElement("button");
		button.type = "button";
		button.className = "btn btn-primary";
		button.textContent = product.in_stock ? "Add to cart" : "Out of stock";
		button.disabled = !product.in_stock;
		button.addEventListener("click", () => addToCart(product.id));
		card.append(button);

		grid.append(card);
	}
}

function renderCart() {
	const lines = cartLines();
	const count = lines.reduce((n, l) => n + l.qty, 0);
	$("cart-count").textContent = String(count);

	$("cart-empty").hidden = lines.length > 0;
	$("cart-panel").hidden = lines.length === 0;
	if (!lines.length) return;

	const currency = lines[0].product.currency;
	const body = $("cart-body");
	body.textContent = "";

	for (const line of lines) {
		const row = document.createElement("tr");

		const name = document.createElement("td");
		name.textContent = line.product.name;

		const qtyCell = document.createElement("td");
		const qty = document.createElement("input");
		qty.type = "number";
		qty.min = "1";
		qty.value = String(line.qty);
		qty.className = "qty";
		qty.addEventListener("change", () => setQty(line.product.id, Number(qty.value) || 0));
		qtyCell.append(qty);

		const unit = document.createElement("td");
		unit.textContent = money(line.product.price, currency);

		const total = document.createElement("td");
		total.textContent = money(line.product.price * line.qty, currency);

		const actions = document.createElement("td");
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "btn btn-ghost small";
		remove.textContent = "Remove";
		remove.addEventListener("click", () => removeFromCart(line.product.id));
		actions.append(remove);

		row.append(name, qtyCell, unit, total, actions);
		body.append(row);
	}

	$("cart-total").textContent = money(cartTotal(), currency);
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
	const response = await fetch(`/api/shop/${path}`, {
		headers: { accept: "application/json" },
		...options,
	});

	let payload = null;
	try {
		payload = await response.json();
	} catch {
		/* fall through to a generic error */
	}

	if (!response.ok) {
		const message = payload?.error || `Request failed (${response.status})`;
		throw new Error(message);
	}
	return payload;
}

async function loadCatalogue() {
	try {
		const data = await api("catalogue");
		state.catalogue = Array.isArray(data?.products) ? data.products : [];
		renderProducts();
		renderCart();
	} catch (error) {
		$("shop-status").textContent = `We could not load products: ${error.message}`;
	}
}

async function submitCheckout(event) {
	event.preventDefault();
	const form = event.currentTarget;
	const errorBox = $("checkout-error");
	const submit = $("checkout-submit");
	errorBox.hidden = true;

	if (!form.reportValidity()) return;

	const lines = cartLines();
	if (!lines.length) {
		errorBox.textContent = "Your cart is empty.";
		errorBox.hidden = false;
		return;
	}

	const data = new FormData(form);
	const payload = {
		customer_name: String(data.get("customer_name") ?? "").trim(),
		customer_email: String(data.get("customer_email") ?? "").trim(),
		customer_phone: String(data.get("customer_phone") ?? "").trim(),
		delivery_address: String(data.get("delivery_address") ?? "").trim(),
		delivery_notes: String(data.get("delivery_notes") ?? "").trim(),
		items: lines.map((l) => ({ product: l.product.id, qty: l.qty })),
		callback_url: `${location.origin}/shop?order=`,
	};

	submit.disabled = true;
	submit.textContent = "Redirecting…";

	try {
		const result = await api("checkout", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify(payload),
		});

		if (!result?.checkout_url) throw new Error("No payment link was returned.");

		// The order exists; clear the cart before handing off to Paystack.
		state.cart = [];
		saveCart();
		window.location.assign(result.checkout_url);
	} catch (error) {
		errorBox.textContent = error.message;
		errorBox.hidden = false;
		submit.disabled = false;
		submit.textContent = "Pay and place order";
	}
}

async function submitTracking(event) {
	event.preventDefault();
	const result = $("track-result");
	result.hidden = false;
	result.textContent = "Looking up your order…";

	const data = new FormData(event.currentTarget);
	const query = new URLSearchParams({
		order: String(data.get("order") ?? "").trim(),
		email: String(data.get("email") ?? "").trim(),
	});

	try {
		const order = await api(`order-status?${query.toString()}`);
		result.textContent = "";
		const heading = document.createElement("h3");
		heading.textContent = `${order.order} — ${order.status}`;
		const payment = document.createElement("p");
		payment.textContent = `Payment: ${order.payment_status} · Total: ${money(order.total, order.currency)}`;
		result.append(heading, payment);

		if (order.tracking_code) {
			const tracking = document.createElement("p");
			tracking.textContent = `Tracking: ${order.tracking_code} ${order.tracking_note ?? ""}`;
			result.append(tracking);
		}

		const list = document.createElement("ul");
		for (const item of order.items ?? []) {
			const li = document.createElement("li");
			li.textContent = `${item.name} × ${item.qty}`;
			list.append(li);
		}
		result.append(list);
	} catch {
		result.textContent = "We could not find an order with that number and email.";
	}
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
$("year").textContent = String(new Date().getFullYear());
$("checkout-form").addEventListener("submit", submitCheckout);
$("track-form").addEventListener("submit", submitTracking);
$("cart-link").addEventListener("click", (event) => {
	event.preventDefault();
	$("cart-panel").scrollIntoView({ behavior: "smooth" });
});
loadCatalogue();

// Returning from Paystack: surface the order number so the shopper can track it.
const returningOrder = new URLSearchParams(location.search).get("order");
if (returningOrder) {
	const banner = $("shop-status");
	banner.textContent = `Thank you. Your order ${returningOrder} has been received and is being confirmed.`;
}
