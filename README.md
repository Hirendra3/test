# 💸 PayBridge Checkout — signed UPI intents, not templated ones

A TypeScript checkout app for the **Payment Bridge API** (`/api/bridge/v1`, PhonePe PG V2 + Easebuzz) that fixes the
one thing that makes bridge integrations fail in production:

> **`intent_url` / `phonepe_intent_url` returns HTTP 200, but the UPI app says “payment failed”.**

This app reads the **`payment_url` token**, decodes it (it is nested base64url JSON), digs the **gateway-signed UPI
intent** out of it, and gives the customer a **Pay** button that actually opens a working payment.

---

## 1. Why the bridge's intent link fails

The bridge's `collect` response contains a field like this:

```json
{
  "payment_url": "https://mercury-t2.phonepe.com/transact/pgv3?token=eyJtZXJjaGFudElkIjoi...",
  "phonepe_intent_url": "upi://pay?pa=...&pn=...&tr=ORDER_1001&am=499.00&cu=INR",
  "upi_intent_url": "upi://pay?pa=...&pn=...&tr=ORDER_1001&am=499.00&cu=INR",
  "qr_string": "upi://pay?pa=...&pn=...&tr=ORDER_1001&am=499.00&cu=INR"
}
```

Those “convenience” intent fields are **assembled by the bridge from the request body**. They are not the intent
PhonePe issued. Four separate reasons make them unusable:

| Problem | What the UPI app sees | Result |
| :-- | :-- | :-- |
| **No `sign=`** | An unregistered-merchant intent | `Invalid merchant` / `Payment failed` |
| **Placeholder payee** | `pa=...`, `pa=merchant@upi`, `pa=YOUR_VPA` | No route to a real account |
| **Missing `mc=` / `orgid=` / `mode=`** | A merchant intent without category/org id | Rejected by PhonePe / GPay |
| **Rebuilt query string** | Params re-ordered / re-encoded, or `am` taken from ₹ instead of paise | `sign` no longer verifies |

The signed intent *does* exist — inside `payment_url`'s `token`. That token is base64url JSON:

```
token  →  { merchantId, merchantTransactionId, amount, instrumentResponse: { intentUrl, qrData } }
                ↑ often wrapped one or two levels deeper, each level also base64url JSON
```

`intentUrl` there carries `pa`, `pn`, `tr`, `am`, `cu`, `mc`, `mode`, `orgid` **and `sign`** — the genuine,
gateway-signed intent. This project extracts it instead of guessing.

---

## 2. What this app does

```
POST /api/pay {pg_type, amount, email, phone}
        │
        ├─ 1. POST {BRIDGE}/collect                  → payment_url, token_url, custom_payment_url…
        ├─ 2. GET  payment_url (hosted page)         → mine HTML/inline JS for token + intent   ┐ parallel
        ├─ 3. GET  {BRIDGE}/session?txn_id=…         → active session payload                    ┘
        │
        ├─ 4. decode every token, recursively (base64url JSON, nested up to 8 levels)
        ├─ 5. harvest every UPI intent, wherever it hides (JSON field, HTML attr, inline script…)
        ├─ 6. judge each one: pa? real VPA? am matches the order? tr matches? sign present & intact?
        ├─ 7. rank: signed+token-derived > page-derived > bridge-templated
        │
        ├─ 8. return  { primary, fallback, apps, qr, intents[], diagnostics, decode }
        │
        └─ later: GET /api/verify/:txnId  → re-check with the gateway (never trust the redirect)
                  POST /api/webhook/:pg    → same, for server-to-server callbacks
```

Rules baked into the ranking:

* The **only** link promoted to the Pay button is one with a real payee, matching amount, matching reference and an
  intact `sign`.
* App deep links (`ppe://`, `tez://`, `paytmmp://`) **reuse the original query string byte-for-byte** — only the
  scheme changes, so the signature still verifies.
* If nothing is provably payable, the button becomes the **hosted gateway checkout** (always works in a browser)
  instead of a link that is guaranteed to fail.
* Broken links are still returned, with a reason per issue, so you can see what the bridge sent.

---

## 3. Quick start

```bash
npm install
npm run dev          # http://localhost:3000  (tsx watch + esbuild watch)
```

Production:

```bash
npm run build        # tsc → dist/, esbuild → public/
npm start            # serves UI + API on :3000
npm test             # 37 tests — decoding, ranking, status, HTTP routes, DOM smoke tests
```

Copy `.env.example` to `.env` (or set the variables in your host):

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `BRIDGE_BASE_URL` | `https://www.jayamanicollections.com` | Bridge host |
| `BRIDGE_API_PREFIX` | `/api/bridge/v1` | Bridge path (`/bridge/v1` also works) |
| `BRIDGE_TIMEOUT_MS` | `15000` | Collect/status timeout |
| `BRIDGE_API_KEY` | – | Only if your deployment protects the bridge |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Used for the default `redirect_url` |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `CORS_ORIGIN` | `*` | Origin allowed to call `/api/*` from a browser |
| `FETCH_PAYMENT_PAGE` | `1` | Read the hosted checkout page for tokens/intents |
| `PAGE_TIMEOUT_MS` | `8000` | Hosted page timeout |
| `DEMO_MODE` | `auto` | `auto` = sandbox plan when the bridge is unreachable / a gateway has no credentials; `on`; `off` |
| `DEFAULT_PG_TYPE` | `phonepe` | Fallback gateway |
| `DEMO_AMOUNT_PAISE` | `49900` | Amount for the sandbox plan |

> **No credentials live in this repo.** The bridge owns every gateway secret and every hash. This app only reads
> the JSON the bridge returns.

---

## 4. This app's API

All responses are JSON. Amounts are **paise** everywhere (₹499.00 → `49900`).

### `GET /api/health`

Bridge reachability + which gateways are configured (cached 20 s).

```bash
curl -s localhost:3000/api/health | jq
```

### `POST /api/pay` — create order + get the pay button

```bash
curl -s -X POST localhost:3000/api/pay \
  -H 'Content-Type: application/json' \
  -d '{
    "pg_type": "phonepe",
    "amount": 49900,
    "customer_email": "customer@example.com",
    "customer_phone": "9876543210",
    "payer_first_name": "Rahul"
  }' | jq
```

```jsonc
{
  "ok": true,
  "demo": false,
  "pgType": "phonepe",
  "txnId": "ORD-MVRWFM66-E67F59",
  "amountPaisa": 49900,
  "amountLabel": "₹499.00",

  "primary": {                       // ← what the UI renders as the Pay button
    "kind": "intent",
    "app": "any",
    "label": "Pay with UPI app",
    "url": "upi://pay?pa=jayamani@ybl&tr=…&am=499.00&cu=INR&mc=5411&orgid=159761&sign=…"
  },
  "fallback": {                      // ← always-usable hosted checkout
    "kind": "hosted",
    "app": "web",
    "label": "Pay on PhonePe secure checkout",
    "url": "https://mercury-t2.phonepe.com/transact/pgv3?token=eyJ…"
  },
  "apps": [                          // ← per-app deep links, same signed query string
    { "kind": "intent", "app": "phonepe", "label": "Pay with PhonePe", "url": "ppe://pay?pa=…&sign=…" },
    { "kind": "intent", "app": "gpay",    "label": "Pay with Google Pay", "url": "tez://upi/pay?pa=…&sign=…" },
    { "kind": "intent", "app": "paytm",   "label": "Pay with Paytm", "url": "paytmmp://pay?pa=…&sign=…" },
    { "kind": "intent", "app": "any",     "label": "Pay with any UPI app", "url": "upi://pay?pa=…&sign=…" }
  ],
  "qr": { "value": "upi://pay?pa=…&sign=…", "dataUrl": "data:image/png;base64,…", "source": "token" },

  "intents": [                       // ← everything found, judged, ranked
    {
      "source": "token",
      "signed": true,
      "usable": true,
      "isPrimary": true,
      "amountPaisa": 49900,
      "txnId": "ORD-MVRWFM66-E67F59",
      "jsonPath": "$<decoded>.instrumentResponse.intentUrl",
      "issues": []
    },
    {
      "source": "bridge-intent-url",
      "signed": false,
      "usable": false,
      "issues": [
        { "severity": "block", "code": "placeholder-vpa", "message": "…" },
        { "severity": "block", "code": "unsigned-intent", "message": "…" }
      ]
    }
  ],

  "diagnostics": [ { "level": "ok", "code": "SIGNED_INTENT", "message": "…" } ],
  "decode": { "sources": [ /* per token: origin, length, layers, intents */ ], "fields": [ /* amount, tr, expiry… */ ], "notes": [ /* steps */ ] },
  "hosted": { "paymentUrl": "…", "tokenUrl": "…", "customPaymentUrl": "…" }
}
```

`ok: false` errors carry `{ "error": { "code", "message", "details" } }` with status `400`, `502`, `503`.

### `GET /api/pay/:txnId` — resume an existing order

Rebuilds the plan from the **session API** (no second transaction is created), for refresh / shared links.

```bash
curl -s "localhost:3000/api/pay/ORDER_1001?pg_type=phonepe" | jq .primary
```

### `POST /api/status` and `GET /api/status/:pgTxnId`

```bash
curl -s -X POST localhost:3000/api/status \
  -H 'Content-Type: application/json' \
  -d '{"pg_type":"phonepe","pg_txn_id":"ORDER_1001","amount":49900}' | jq

curl -s "localhost:3000/api/status/ORDER_1001?pg_type=easebuzz&amount=49900" | jq
```

```json
{
  "ok": true,
  "pgType": "phonepe",
  "txnId": "ORDER_1001",
  "status": "success",
  "amountPaisa": 49900,
  "amountMatches": true,
  "raw": { "state": "COMPLETED", "merchantOrderId": "ORDER_1001", "amount": 49900 },
  "diagnostics": []
}
```

`status` is normalised to `success` / `failed` / `pending` / `unknown` across both gateways
(`COMPLETED`, `TXN_SUCCESS`, `TXN_FAILURE`, `PENDING`, …). Pass `amount` to get `amountMatches` — never trust a
client-reported amount.

### `POST /api/decode` — “why is my link broken?”

Accepts a `payment_url`, a raw token, a checkout page URL, or the failing intent itself.

```bash
curl -s -X POST localhost:3000/api/decode -H 'Content-Type: application/json' \
  -d '{"url":"upi://pay?pa=merchant@upi&pn=Merchant%20Name&tr=ORDER_1001&am=499.00&cu=INR"}' | jq '.intents[0].issues'
```

```json
[
  { "severity": "block", "code": "placeholder-vpa", "message": "Intent payee is the literal placeholder \"merchant@upi\" …" },
  { "severity": "info",  "code": "missing-mc", "message": "No mc= …" },
  { "severity": "block", "code": "unsigned-intent", "message": "No sign= parameter …" }
]
```

The same tool is in the UI (**Inspector**, step 2).

### `POST /api/verify` and `GET /api/verify/:txnId` — trust the gateway, not the redirect

Gateways return the customer to `redirect_url` with query/form params — **all attacker-controllable**. This endpoint
throws the claimed status away, asks the bridge for the authoritative state, and compares the amount.

```bash
# PhonePe style query return
curl -s "localhost:3000/api/verify/ORDER_1001?status=success&pg_type=phonepe&amount=49900" | jq

# Easebuzz style form post
curl -s -X POST localhost:3000/api/verify \
  -d 'txnid=ORDER_1001&status=success&amount=49900' | jq
```

```json
{
  "ok": true,
  "verified": true,
  "txnId": "ORDER_1001",
  "claimedStatus": "success",
  "status": "success",
  "amountPaisa": 49900,
  "amountMatches": true,
  "demo": false,
  "checkedAt": "2026-10-28T09:31:02.114Z",
  "message": "Payment verified with the gateway."
}
```

A redirect that lies is called out explicitly:

```json
{ "status": "pending", "verified": false,
  "message": "The redirect claims "success" but the gateway says pending. Trust the gateway." }
```

`verified` is only `true` for a terminal `success` **with a matching amount** — safe to fulfil on.

### `POST /api/webhook/:pgType` — server-to-server callbacks

Same verification, form-encoded or JSON, no browser session needed. Always answers `200` for well-formed bodies
(and `200 { ok: false }` for malformed ones) so gateways don't retry forever; the state comes from the bridge.

```bash
curl -s -X POST localhost:3000/api/webhook/easebuzz \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'txnid=ORDER_1002&status=success&amount=49900' | jq
```

### Gateway return pages

`POST /pay/:txnId`, `POST|GET /return`, `POST|GET /payment/callback` accept a gateway callback, keep only the order
reference, and `303` the browser to `/pay/<txn>?verify=1&…` where the SPA renders a verified banner. Point
`redirect_url` at any of them.

---

## 5. The UI

* Left card: order form (gateway, amount in ₹, customer, optional `txn_id` / `redirect_url`).
* Right card: the generated plan — a **big Pay button**, per-app buttons (PhonePe / Google Pay / Paytm / any UPI),
  a scannable **QR of the signed intent**, and the hosted-checkout fallback.
* Tabs: **Diagnostics** (what happened), **Intents** (every link found + why each is or is not payable),
  **Decoded token** (origins, layers, `amount`/`tr`/expiry), **Raw JSON**.
* **“Pay without leaving this page”** loads `checkout_script` and calls
  `window.PhonePeCheckout.transact({ tokenUrl, type: 'IFRAME', callback })` — the in-page option documented by the
  bridge. If the script is blocked (CSP, offline, gateway down) it degrades to the hosted-checkout button instead of
  failing silently. Shown only when `hosted.canEmbed` is true (never for Easebuzz or sandbox plans).
* After a Pay tap the UI polls `/api/status` and reports `pending → success/failed` in place.
* Coming back from a gateway, the SPA calls `/api/verify/:txnId` and renders its own banner:
  ✓ verified / ✕ failed / … pending, the gateway amount, and the **claimed vs actual** state.
* Refresh on `/pay/:txnId` resumes the order (session API, then a local cache).
* Responsive, light/dark, keyboard accessible, no client-side framework (~21 kB of JS).

---

## 6. Integrating from your own site

```html
<script>
  async function pay() {
    const res = await fetch('https://your-checkout.example.com/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pg_type: 'phonepe',
        amount: 49900,                       // paise — always
        customer_email: 'customer@example.com',
        customer_phone: '9876543210',
      }),
    });
    const plan = await res.json();

    if (plan.primary?.kind === 'intent') {
      location.href = plan.primary.url;      // signed UPI intent → opens the app
    } else {
      location.href = plan.primary.url;      // hosted checkout fallback
    }
    // keep plan.txnId; verify server-side before fulfilling
  }
</script>
```

On your own server, when the customer lands back (or your webhook fires):

```js
const res = await fetch(`https://your-checkout.example.com/api/verify/${txnId}?pg_type=phonepe&amount=${orderTotal}`);
const result = await res.json();

if (result.verified && result.amountPaisa === orderTotal) {
  await markOrderPaid(txnId);          // idempotent on txn_id
} else {
  console.warn('not fulfilled:', result.status, result.message);
}
```

**Never fulfil an order on the browser redirect alone.** Call `/api/status` from your server (or use the bridge
webhook) and compare `amountPaisa` with your own order total.

---

## 7. Project structure

```
src/
  server.ts                 boot: config → bridge client → app.listen
  app.ts                    express wiring: JSON/urlencoded, CORS, API, gateway returns, SPA
  routes.ts                 validation (zod), CORS, error envelope
  config.ts                 env parsing
  bridge/client.ts          bridge HTTP client (collect / session / status / page fetch)
  services/
    checkout.ts             collect → page + session → plan  (+ demo fallback, resume)
    status.ts               status normalisation, amount checks, health cache
    verify.ts               return/webhook verification (gateway is the source of truth)
    decode.ts               the Inspector endpoint
  lib/
    tokenDecoder.ts         recursive base64url-JSON walker + HTML miner
    upi.ts                  intent parsing/validation, app deep links (byte-identical query)
    planner.ts              ranking, pay actions, diagnostics
    qr.ts, base64.ts, http.ts, types.ts
  public/                   index.html, styles.css, app.ts (esbuild → public/)
tests/
  payment.test.ts           18 tests: decoding, ranking, status, validation
  api.test.ts               17 tests: routes, errors, verify/webhook, CORS (supertest + stubbed bridge)
  ui.test.ts                2 DOM smoke tests: pay button/QR/tabs/embed + verified return banner
scripts/                    dev.mjs, build-client.mjs, ensure-build.mjs
```

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| :-- | :-- | :-- |
| UPI app: “payment failed / invalid merchant” | You are using the bridge's `intent_url` (unsigned) | Use `primary.url` from `/api/pay` — it comes from the token and keeps `sign` |
| Pay button shows *hosted only* | No signed intent in the payload; host page/token unreadable | Check **Diagnostics**; ensure `payment_url` is returned and `FETCH_PAYMENT_PAGE=1` |
| `503 PG_NOT_CONFIGURED` | Gateway credentials missing on the bridge | Fix them on the bridge, or run with `DEMO_MODE=auto` to keep the UI testable |
| `INTENT_UNPAYABLE` but you set `upi_intent_url` yourself | The bridge never signs client-supplied intents | Read the token; don't build intents |
| Amount on the intent ≠ order | Bridge built the intent from a different amount / rupees vs paise | `amount-mismatch` is blocking; send paise |
| QR missing | Intent longer than 1200 chars | Use the hosted checkout link (the UI already offers it) |
| `DEMO_PLAN` chip in the UI | Bridge unreachable from this host | Check egress/DNS, `BRIDGE_BASE_URL`, or turn `DEMO_MODE=off` |
| In-page modal says the script could not load | `checkout.js` blocked by CSP or offline | Allow `mercury.phonepe.com` in `script-src`, or use the hosted button |
| Return page shows “claim vs gateway” mismatch | Someone edited the redirect params (or a stale callback) | Expected: your fulfilment must key off `verified: true` only |
| Webhook keeps being retried | Your handler returned non-2xx | Return `200` once `verify` responds; make it idempotent by `txn_id` |

---

## 9. Security notes

* Bridge credentials never reach this app or the browser; the bridge signs and hashes everything.
* `/api/decode` fetches user-supplied URLs — it rejects non-`http(s)`, loopback, link-local and private ranges.
  Put it behind auth if you expose it publicly.
* Plan responses include long tokens; they are short-lived by nature. Don't log them at `debug` in production.
* Verify every payment server-side (`/api/status`, compare amount) before shipping goods.
* `CORS_ORIGIN` defaults to `*` for convenience — set it to your real website origin.

---

Built for the **Simple Multi-Gateway Payment Bridge API v1.0.0** — PhonePe PG V2 + Easebuzz.
