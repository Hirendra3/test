/**
 * Checkout UI.
 *
 * The only rule the UI obeys: it renders the `primary` action the server
 * decided on, and that action always points at a link the server could verify
 * (signed intent) or a gateway-hosted page. It never fabricates an intent URL.
 */

import type {
  DecodeReport,
  IntentView,
  PayAction,
  PayPlan,
  StatusResult,
} from '../lib/types';

interface VerifyResult {
  ok: boolean;
  verified: boolean;
  txnId: string;
  claimedStatus: string | null;
  status: 'success' | 'failed' | 'pending' | 'unknown';
  amountPaisa: number | null;
  amountMatches: boolean | null;
  demo?: boolean;
  message: string;
}

interface PhonePeCheckoutApi {
  transact(options: {
    tokenUrl?: string;
    orderId?: string;
    type?: 'IFRAME' | 'REDIRECT';
    callback?: (response: string) => void;
  }): void;
}

declare global {
  interface Window {
    PhonePeCheckout?: PhonePeCheckoutApi;
  }
}

type DecodeResponse = {
  ok: boolean;
  kind?: string;
  intents?: IntentView[];
  notes?: string[];
  diagnostics?: { level: string; message: string; code: string }[];
  error?: { code: string; message: string; details?: unknown };
};

const $ = <T extends Element = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);

const isMobile = /Android|iPhone|iPad|iPod|Mobile|phone/i.test(navigator.userAgent);

let currentPlan: PayPlan | null = null;
let pollTimer: number | null = null;
let pollCount = 0;

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rupeesToPaisa(raw: string): number {
  const clean = raw.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) throw new Error('Enter an amount like 499 or 499.50');
  const [rupeePart, paisePart = ''] = clean.split('.');
  const paise = Number(rupeePart) * 100 + Number((paisePart + '00').slice(0, 2));
  return paise;
}

function paisaToRupees(paisa: number): string {
  return (paisa / 100).toFixed(2);
}

function money(paisa: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(paisa / 100);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { ok?: boolean; error?: { code: string; message: string; details?: unknown } })
    | null;

  if (!response.ok || (payload && payload.ok === false)) {
    const message = payload?.error?.message ?? `Request failed (HTTP ${response.status})`;
    const error = new Error(message) as Error & { code?: string; details?: unknown };
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload as T;
}

function short(value: string, head = 26, tail = 8): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function copy(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* theme                                                                      */
/* -------------------------------------------------------------------------- */

function initTheme(): void {
  const stored = localStorage.getItem('pb-theme');
  if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored;

  $<HTMLButtonElement>('#theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('pb-theme', next);
  });
}

/* -------------------------------------------------------------------------- */
/* health                                                                     */
/* -------------------------------------------------------------------------- */

interface HealthReport {
  bridge: {
    reachable: boolean;
    latencyMs: number | null;
    error: string | null;
    payload: { enabled_pgs?: string[]; version?: string; pg_status?: Record<string, boolean> } | null;
    missingGateways: string[];
  };
  demoMode: string;
}

async function initHealth(): Promise<HealthReport | null> {
  const pill = $<HTMLElement>('#bridge-pill');
  const text = $('#bridge-pill-text');
  if (!pill || !text) return null;

  try {
    const health = await api<HealthReport>('/api/health');
    if (!health.bridge.reachable) {
      pill.dataset.state = 'warn';
      text.textContent = 'bridge unreachable · demo mode';
      pill.title = health.bridge.error ?? '';
      return health;
    }
    const enabled = health.bridge.payload?.enabled_pgs ?? [];
    const missing = health.bridge.missingGateways;
    if (missing.length > 0) {
      pill.dataset.state = 'warn';
      text.textContent = `bridge ok · ${missing.join(', ')} unconfigured`;
    } else {
      pill.dataset.state = 'ok';
      text.textContent = `bridge ok · ${health.bridge.latencyMs ?? '—'} ms · ${enabled.length || 0} pg`;
    }
    pill.title = `enabled: ${enabled.join(', ') || 'unknown'}`;
    return health;
  } catch (error) {
    pill.dataset.state = 'error';
    text.textContent = 'bridge status unknown';
    pill.title = error instanceof Error ? error.message : '';
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* form                                                                       */
/* -------------------------------------------------------------------------- */

function bindForm(): void {
  const form = $<HTMLFormElement>('#pay-form');
  const amountInput = $<HTMLInputElement>('#amount');
  const hint = $('#amount-hint');
  const submit = $<HTMLButtonElement>('#submit-btn');
  const errorBox = $('#form-error');

  amountInput?.addEventListener('input', () => {
    if (!hint || !amountInput) return;
    try {
      const paisa = rupeesToPaisa(amountInput.value);
      hint.textContent = `= ${paisa} paise`;
      hint.style.color = '';
    } catch {
      hint.textContent = 'enter a valid rupee amount';
      hint.style.color = 'var(--red)';
    }
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form || !submit || !errorBox) return;

    const data = new FormData(form);
    const get = (key: string): string => String(data.get(key) ?? '').trim();

    errorBox.hidden = true;
    const label = submit.querySelector('.btn-label');
    const spinner = submit.querySelector<HTMLElement>('.spinner');
    submit.disabled = true;
    if (spinner) spinner.hidden = false;
    if (label) label.textContent = 'Creating order…';

    try {
      const amount = rupeesToPaisa(get('amount'));
      const body: Record<string, unknown> = {
        pg_type: get('pg_type') || 'phonepe',
        amount,
        customer_email: get('customer_email'),
        customer_phone: get('customer_phone'),
      };
      if (get('txn_id')) body.txn_id = get('txn_id');
      if (get('redirect_url')) body.redirect_url = get('redirect_url');
      if (get('payer_first_name')) body.payer_first_name = get('payer_first_name');
      if (get('payer_last_name')) body.payer_last_name = get('payer_last_name');

      const plan = await api<PayPlan>('/api/pay', { method: 'POST', body: JSON.stringify(body) });
      renderPlan(plan, 'Created just now');
      history.replaceState({}, '', `/pay/${encodeURIComponent(plan.txnId)}`);
      $('.plan-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      const err = error as Error & { code?: string; details?: unknown };
      errorBox.hidden = false;
      errorBox.innerHTML = `<strong>${esc(err.code ?? 'ERROR')}</strong> — ${esc(err.message)}${
        err.details ? `<br /><small>${esc(JSON.stringify(err.details))}</small>` : ''
      }`;
    } finally {
      submit.disabled = false;
      if (spinner) spinner.hidden = true;
      if (label) label.textContent = 'Create payment & get pay button';
    }
  });
}

function prefillFromQuery(): void {
  const params = new URLSearchParams(location.search);
  const map: Record<string, string> = {
    amount: 'amount',
    pg_type: 'pg_type',
    txn_id: 'txn_id',
    email: 'customer_email',
    phone: 'customer_phone',
  };
  for (const [param, id] of Object.entries(map)) {
    const value = params.get(param);
    if (!value) continue;
    const input = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (input) input.value = value;
  }
  const amountInput = $<HTMLInputElement>('#amount');
  if (amountInput?.value) amountInput.dispatchEvent(new Event('input'));
}

/** Load an external script once; resolves false when it is blocked or 404s. */
function loadScript(src: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-pb-src="${src}"]`);
    if (existing) {
      resolve(true);
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.pbSrc = src;
    const timer = window.setTimeout(() => resolve(false), timeoutMs);
    script.onload = () => {
      window.clearTimeout(timer);
      resolve(true);
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

function setTracker(state: 'pending' | 'success' | 'failed', text: string): void {
  const tracker = document.getElementById('pay-tracker');
  const label = document.getElementById('pay-tracker-text');
  if (!tracker || !label) return;
  tracker.hidden = false;
  tracker.dataset.state = state;
  label.textContent = text;
}

function showVerifyBanner(result: VerifyResult): void {
  const host = document.getElementById('verify-banner');
  if (!host) return;

  const ok = result.verified;
  const level = ok ? 'ok' : result.status === 'failed' ? 'error' : 'warn';
  const icon = ok ? '✓' : result.status === 'failed' ? '✕' : '…';
  const amountLine =
    result.amountPaisa !== null
      ? `<div class="verify-meta">Gateway amount ${esc(money(result.amountPaisa))}${
          result.amountMatches === false ? ' — <strong>does not match this order</strong>' : ''
        }</div>`
      : '';

  host.innerHTML = `
    <div class="alert alert-${level === 'ok' ? 'ok' : level === 'error' ? 'error' : 'warn'} verify-banner">
      <span class="verify-icon">${icon}</span>
      <div>
        <strong>${ok ? 'Payment verified' : result.status === 'failed' ? 'Payment failed' : 'Awaiting confirmation'}</strong>
        <div>${esc(result.message)}</div>
        ${amountLine}
        ${
          result.claimedStatus
            ? `<div class="verify-meta">Redirect claimed <code>${esc(result.claimedStatus)}</code> · gateway says <code>${esc(result.status)}</code></div>`
            : ''
        }
        ${result.demo ? '<div class="verify-meta">Sandbox response — the live bridge was not reachable.</div>' : ''}
      </div>
    </div>`;
  host.hidden = false;
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* -------------------------------------------------------------------------- */
/* plan rendering                                                             */
/* -------------------------------------------------------------------------- */

function chip(label: string, kind = '', icon = ''): string {
  return `<span class="chip ${kind}">${icon}${esc(label)}</span>`;
}

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const CROSS_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

const APP_BADGE: Record<string, { cls: string; text: string }> = {
  phonepe: { cls: 'badge-phonepe', text: 'P' },
  gpay: { cls: 'badge-gpay', text: 'G' },
  paytm: { cls: 'badge-paytm', text: 'T' },
  any: { cls: 'badge-any', text: 'UPI' },
  web: { cls: 'badge-any', text: 'WEB' },
  easebuzz: { cls: 'badge-any', text: 'EB' },
};

function intentCard(intent: IntentView, primary = false): string {
  const params = Object.entries(intent.params);
  const preferred = ['pa', 'pn', 'am', 'cu', 'tr', 'mc', 'mode', 'orgid', 'sign'];
  const ordered = [
    ...preferred.map((key) => params.find(([k]) => k === key)).filter((entry): entry is [string, string] => Boolean(entry)),
    ...params.filter(([k]) => !preferred.includes(k)),
  ].slice(0, 10);

  const issues = intent.issues
    .map(
      (issue) =>
        `<li class="${issue.severity === 'block' ? 'block' : ''}"><span>${esc(issue.message)}</span></li>`,
    )
    .join('');

  return `
    <div class="intent-card ${intent.usable ? '' : 'bad'}">
      <div class="intent-top">
        ${chip(intent.source, 'violet')}
        ${intent.signed ? chip('signed', 'ok', CHECK_ICON) : chip('unsigned', 'bad', CROSS_ICON)}
        ${primary ? chip('in use', 'ok') : ''}
        <button class="copy-btn" type="button" data-copy="${esc(intent.raw)}">copy</button>
      </div>
      <code class="url-box">${esc(intent.raw)}</code>
      <dl class="kv" style="margin-top:10px">
        ${ordered
          .map(
            ([key, value]) =>
              `<dt>${esc(key)}</dt><dd>${
                key === 'sign' ? esc(short(value, 18, 8)) : esc(value)
              }</dd>`,
          )
          .join('')}
      </dl>
      ${issues ? `<ul class="issues">${issues}</ul>` : ''}
      <p class="note" style="margin-bottom:0">found at <code>${esc(intent.jsonPath)}</code></p>
    </div>`;
}

function renderIntentsList(intents: IntentView[], primaryRaw: string | null): string {
  if (intents.length === 0) {
    return `<p class="note">No UPI intent was found in this payload.</p>`;
  }
  return intents
    .map((intent) => intentCard(intent, intent.raw === primaryRaw))
    .join('');
}

function renderDiagnostics(plan: PayPlan): string {
  return plan.diagnostics
    .map((diag) => {
      const tag =
        diag.level === 'ok' ? '✓' : diag.level === 'error' ? '!' : diag.level === 'warn' ? '△' : 'i';
      return `<div class="diag" data-level="${diag.level}">
        <span class="tag">${tag}</span>
        <span><strong>${esc(diag.code)}</strong> — ${esc(diag.message)}</span>
      </div>`;
    })
    .join('');
}

function renderDecodeReport(report: DecodeReport): string {
  const sources = report.sources
    .map(
      (source) => `<div class="intent-card">
        <div class="intent-top">
          ${chip(source.label, 'violet')}
          ${chip(`${source.tokenLength} chars`)}
          ${chip(`${source.layers} layer${source.layers === 1 ? '' : 's'}`)}
          ${chip(`${source.intents} intent${source.intents === 1 ? '' : 's'}`)}
        </div>
        <dl class="kv">
          <dt>from</dt><dd>${esc(source.origin)}</dd>
          <dt>token</dt><dd>${esc(source.tokenPreview)}</dd>
          ${source.errors.map((error) => `<dt>error</dt><dd>${esc(error)}</dd>`).join('')}
        </dl>
      </div>`,
    )
    .join('');

  const fields =
    report.fields.length > 0
      ? `<div class="section-label">Token fields</div><dl class="kv">${report.fields
          .map((field) => `<dt>${esc(field.key)}</dt><dd>${esc(field.value)}</dd>`)
          .join('')}</dl>`
      : '';

  const notes = report.notes.length
    ? `<div class="section-label">Steps</div>${report.notes
        .map((note) => `<p class="note">• ${esc(note)}</p>`)
        .join('')}`
    : '';

  return `${notes}${sources ? `<div class="section-label">Decoded tokens</div>${sources}` : ''}${fields}`;
}

function payZone(plan: PayPlan): string {
  const primary = plan.primary;
  if (!primary) {
    return `<div class="alert alert-error">
      <strong>No payable action.</strong> The bridge returned neither a signed intent nor a hosted checkout URL.
      Check <code>/api/health</code> and the gateway credentials.
    </div>`;
  }

  if (primary.kind === 'hosted') {
    return `
      <div class="pay-zone">
        <a class="pay-btn" href="${esc(primary.url)}" target="_blank" rel="noreferrer" data-pay-action="hosted">
          <span class="icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="2.5" y="5" width="19" height="14" rx="3" /><path d="M2.5 10h19" />
            </svg>
          </span>
          <span class="stack">
            <span class="title">${esc(primary.label)}</span>
            <span class="sub">Secure gateway page · ${esc(plan.amountLabel)}</span>
          </span>
          <span class="arrow">→</span>
        </a>
        <p class="fallback-hint">
          No signed UPI intent could be recovered from this payload, so the hosted checkout is the
          safest route. Use the Inspector below to see what the token contained.
        </p>
      </div>`;
  }

  const apps = plan.apps
    .map((action) => {
      const badge = APP_BADGE[action.app] ?? APP_BADGE.any;
      return `<a class="app-link" href="${esc(action.url)}" data-pay-action="${esc(action.app)}">
        <span class="badge ${badge?.cls ?? 'badge-any'}">${badge?.text ?? 'UPI'}</span>
        <span>${esc(action.label)}</span>
      </a>`;
    })
    .join('');

  const qr = plan.qr?.dataUrl
    ? `<div class="qr-block">
        <img src="${plan.qr.dataUrl}" alt="Scan to pay ${esc(plan.amountLabel)}" />
        <div class="qr-meta">
          <strong>Scan with any UPI app</strong>
          The QR encodes the same gateway-signed intent — payee, amount and reference are locked.
        </div>
      </div>`
    : '';

  const embedButton = plan.hosted.canEmbed
    ? `<button class="embed-btn" type="button" id="embed-pay">
        <span class="embed-dot"></span>
        <span>Pay without leaving this page</span>
        <small>PhonePe secure iframe</small>
      </button>`
    : '';

  const hostedFallback =
    plan.fallback && plan.fallback.url !== primary.url
      ? `<div class="fallback-row">
          <a class="fallback-btn" href="${esc(plan.fallback.url)}" target="_blank" rel="noreferrer" data-pay-action="hosted">
            <span>${esc(plan.fallback.label)}<small>${esc(plan.fallback.hint ?? '')}</small></span>
            <span>↗</span>
          </a>
        </div>`
      : '';

  return `
    <div class="pay-zone">
      <a class="pay-btn" href="${esc(primary.url)}" data-pay-action="primary">
        <span class="icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="6" y="2.5" width="12" height="19" rx="3" />
            <path d="M12 18h.01" />
          </svg>
        </span>
        <span class="stack">
          <span class="title">Pay ${esc(plan.amountLabel)}${isMobile ? ' in your UPI app' : ' — scan or tap'}</span>
          <span class="sub">Signed by the gateway · verified intent</span>
        </span>
        <span class="arrow">→</span>
      </a>
      <div class="app-grid">${apps}</div>
      ${qr}
      ${embedButton}
      ${hostedFallback}
    </div>`;
}

function cacheKey(txnId: string): string {
  return `pb-plan:${txnId}`;
}

function cachePlan(plan: PayPlan): void {
  try {
    sessionStorage.setItem(cacheKey(plan.txnId), JSON.stringify(plan));
  } catch {
    /* storage full or disabled — the plan is still on screen */
  }
}

function readCachedPlan(txnId: string): PayPlan | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(txnId));
    return raw ? (JSON.parse(raw) as PayPlan) : null;
  } catch {
    return null;
  }
}

function renderPlan(plan: PayPlan, subtitle: string): void {
  currentPlan = plan;
  cachePlan(plan);
  const empty = $('#plan-empty');
  const body = $('#plan-body');
  if (!empty || !body) return;

  empty.hidden = true;
  body.hidden = false;

  const primaryIntent = plan.intents.find((intent) => intent.isPrimary) ?? null;
  const brokenCount = plan.intents.filter((intent) => !intent.usable).length;

  const chips = [
    plan.primary?.kind === 'intent' && primaryIntent?.signed
      ? chip('signed intent', 'ok', CHECK_ICON)
      : plan.primary?.kind === 'intent'
        ? chip('unsigned intent', 'warn')
        : chip('hosted only', 'warn'),
    primaryIntent ? chip(`from ${primaryIntent.source}`, 'violet') : '',
    brokenCount > 0 ? chip(`${brokenCount} broken link${brokenCount === 1 ? '' : 's'}`, 'bad') : '',
    plan.demo ? chip('demo / sandbox', 'warn') : '',
    chip(plan.pgType),
  ]
    .filter(Boolean)
    .join('');

  body.innerHTML = `
    <div class="plan-head">
      <div class="order">
        <span class="order-label">Order</span>
        <span class="order-id" title="${esc(plan.txnId)}">${esc(plan.txnId)}</span>
        <span class="note">${esc(subtitle)}</span>
      </div>
      <div class="amount">${esc(plan.amountLabel)}</div>
    </div>
    <div class="chips">${chips}</div>

    ${plan.demo ? `<div class="alert alert-warn" style="margin-top:14px">
      <strong>Sandbox plan.</strong> ${esc(plan.demoReason ?? 'The live bridge was not reachable.')}
      Links below are generated locally and will not move money.
    </div>` : ''}

    ${payZone(plan)}

    <div class="tracker" id="pay-tracker" hidden>
      <span class="beacon"></span><span id="pay-tracker-text"></span>
    </div>

    <div class="tabs">
      <div class="tab-buttons" role="tablist">
        <button class="tab-btn" role="tab" data-tab="diag" aria-selected="true">Diagnostics</button>
        <button class="tab-btn" role="tab" data-tab="intents" aria-selected="false">Intents (${plan.intents.length})</button>
        <button class="tab-btn" role="tab" data-tab="decode" aria-selected="false">Decoded token</button>
        <button class="tab-btn" role="tab" data-tab="raw" aria-selected="false">Raw JSON</button>
      </div>
      <div class="tab-panel" data-panel="diag">${renderDiagnostics(plan)}</div>
      <div class="tab-panel" data-panel="intents" hidden>
        ${renderIntentsList(plan.intents, primaryIntent?.raw ?? null)}
      </div>
      <div class="tab-panel" data-panel="decode" hidden>${renderDecodeReport(plan.decode)}</div>
      <div class="tab-panel" data-panel="raw" hidden>
        <pre class="raw">${esc(JSON.stringify(plan, null, 2))}</pre>
      </div>
    </div>`;

  bindTabs(body);
  bindCopies(body);
  bindPayActions();
  bindEmbed(plan);
}

function bindTabs(root: HTMLElement): void {
  const buttons = root.querySelectorAll<HTMLButtonElement>('.tab-btn');
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      buttons.forEach((other) => other.setAttribute('aria-selected', String(other === button)));
      root.querySelectorAll<HTMLElement>('.tab-panel').forEach((panel) => {
        panel.hidden = panel.dataset.panel !== button.dataset.tab;
      });
    });
  });
}

function bindCopies(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => {
      copy(button.dataset.copy ?? '');
      const original = button.textContent;
      button.textContent = 'copied';
      setTimeout(() => {
        button.textContent = original;
      }, 1200);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* status polling                                                             */
/* -------------------------------------------------------------------------- */

function startPolling(): void {
  const plan = currentPlan;
  if (!plan) return;

  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollCount = 0;

  const tracker = document.getElementById('pay-tracker');
  const label = document.getElementById('pay-tracker-text');
  if (!tracker || !label) return;

  tracker.hidden = false;
  tracker.dataset.state = 'pending';
  label.textContent = 'Waiting for the gateway to confirm…';

  const tick = async (): Promise<void> => {
    pollCount += 1;
    try {
      const query = new URLSearchParams({ pg_type: plan.pgType, amount: String(plan.amountPaisa) });
      const result = await api<StatusResult>(`/api/status/${encodeURIComponent(plan.txnId)}?${query}`);
      if (result.status === 'success') {
        tracker.dataset.state = 'success';
        label.textContent =
          result.amountMatches === false
            ? 'Paid, but the amount does not match this order.'
            : 'Payment confirmed by the gateway.';
        stopPolling();
        return;
      }
      if (result.status === 'failed') {
        tracker.dataset.state = 'failed';
        label.textContent = 'Payment failed or was cancelled. You can retry with the button above.';
        stopPolling();
        return;
      }
      label.textContent = `Still pending — checking again (${pollCount})…`;
    } catch (error) {
      label.textContent = `Status check failed: ${(error as Error).message}`;
    }

    if (pollCount >= 40) {
      label.textContent = 'Gave up polling after 4 minutes. Use the Inspector to check manually.';
      stopPolling();
    }
  };

  void tick();
  pollTimer = window.setInterval(tick, 6000);
}

function stopPolling(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = null;
}

function bindEmbed(plan: PayPlan): void {
  const button = document.getElementById('embed-pay') as HTMLButtonElement | null;
  if (!button) return;

  button.addEventListener('click', async () => {
    const script = plan.hosted.checkoutScript;
    const tokenUrl = plan.hosted.tokenUrl ?? plan.hosted.paymentUrl;
    if (!script || !tokenUrl) return;

    button.disabled = true;
    setTracker('pending', 'Opening PhonePe secure checkout…');

    const loaded = await loadScript(script);
    const checkout = window.PhonePeCheckout;
    if (!loaded || !checkout?.transact) {
      button.disabled = false;
      setTracker(
        'failed',
        'PhonePe checkout script could not load here (blocked or offline). Use the secure-checkout button instead.',
      );
      return;
    }

    try {
      checkout.transact({
        tokenUrl,
        type: 'IFRAME',
        callback: (response: string) => {
          button.disabled = false;
          if (/cancel/i.test(response)) {
            setTracker('pending', 'Checkout closed before payment. You can try again.');
            return;
          }
          if (/success/i.test(response)) {
            setTracker('pending', 'PhonePe reports success — verifying with the gateway…');
            void verifyOrder(plan.txnId, plan.pgType, plan.amountPaisa);
            return;
          }
          setTracker('failed', `PhonePe returned "${response}". Verify with the status tab before retrying.`);
        },
      });
    } catch (error) {
      button.disabled = false;
      setTracker('failed', `Could not open the in-page checkout: ${(error as Error).message}`);
    }
  });
}

/** Ask the server to confirm a payment with the gateway (never trust the UI). */
async function verifyOrder(txnId: string, pgType: string, amountPaisa?: number): Promise<VerifyResult | null> {
  try {
    const query = new URLSearchParams({ pg_type: pgType });
    if (amountPaisa) query.set('amount', String(amountPaisa));
    const result = await api<VerifyResult>(`/api/verify/${encodeURIComponent(txnId)}?${query}`);
    showVerifyBanner(result);
    if (result.status === 'success') {
      setTracker(result.amountMatches === false ? 'failed' : 'success', result.message);
      stopPolling();
    } else if (result.status === 'failed') {
      setTracker('failed', result.message);
      stopPolling();
    } else if (result.status === 'pending') {
      setTracker('pending', result.message);
    }
    return result;
  } catch (error) {
    setTracker('failed', `Verification failed: ${(error as Error).message}`);
    return null;
  }
}

function bindPayActions(): void {
  document.querySelectorAll<HTMLAnchorElement>('[data-pay-action]').forEach((link) => {
    if (link.dataset.bound === '1') return;
    link.dataset.bound = '1';
    link.addEventListener('click', () => {
      // Give the browser a tick to hand off to the UPI app, then poll.
      setTimeout(startPolling, 1500);
    });
  });
}

function ensureTracker(): void {
  const zone = document.querySelector('.plan-card');
  if (!zone || document.getElementById('pay-tracker')) return;
  const tracker = document.createElement('div');
  tracker.className = 'tracker';
  tracker.id = 'pay-tracker';
  tracker.hidden = true;
  tracker.innerHTML = '<span class="beacon"></span><span id="pay-tracker-text"></span>';
  zone.appendChild(tracker);
}

/* -------------------------------------------------------------------------- */
/* inspector                                                                  */
/* -------------------------------------------------------------------------- */

function bindInspector(): void {
  const form = $<HTMLFormElement>('#decode-form');
  const input = $<HTMLInputElement>('#decode-input');
  const result = $('#decode-result');
  if (!form || !input || !result) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;

    result.hidden = false;
    result.innerHTML = '<p class="note">Decoding…</p>';
    try {
      const response = await api<DecodeResponse>('/api/decode', {
        method: 'POST',
        body: JSON.stringify({ url: value }),
      });
      const intents = response.intents ?? [];
      const diagnostics = (response.diagnostics ?? [])
        .map(
          (diag) =>
            `<div class="diag" data-level="${esc(diag.level)}">
              <span class="tag">${diag.level === 'error' ? '!' : diag.level === 'warn' ? '△' : 'i'}</span>
              <span><strong>${esc(diag.code)}</strong> — ${esc(diag.message)}</span>
            </div>`,
        )
        .join('');
      result.innerHTML = `
        <div class="chips" style="margin-bottom:12px">
          ${chip(`input: ${response.kind ?? 'unknown'}`, 'violet')}
          ${chip(`${intents.length} intent${intents.length === 1 ? '' : 's'}`)}
          ${intents.some((i) => i.usable) ? chip('payable', 'ok', CHECK_ICON) : chip('not payable', 'bad', CROSS_ICON)}
        </div>
        ${diagnostics}
        ${(response.notes ?? []).map((note) => `<p class="note">• ${esc(note)}</p>`).join('')}
        ${renderIntentsList(intents, null)}`;
      bindCopies(result);
    } catch (error) {
      result.innerHTML = `<div class="alert alert-error">${esc((error as Error).message)}</div>`;
    }
  });
}

/* -------------------------------------------------------------------------- */
/* boot                                                                       */
/* -------------------------------------------------------------------------- */

async function resumeFromUrl(): Promise<boolean> {
  const match = /^\/pay\/(.+)$/.exec(location.pathname);
  if (!match || !match[1]) return false;

  const txnId = decodeURIComponent(match[1]);
  try {
    const plan = await api<PayPlan>(`/api/pay/${encodeURIComponent(txnId)}`);
    renderPlan(plan, 'Resumed from an active session');
    ensureTracker();
    return true;
  } catch (error) {
    const cached = readCachedPlan(txnId);
    if (cached) {
      renderPlan(cached, 'Restored from this browser — the live session could not be refreshed');
      return true;
    }
    const errorBox = $('#form-error');
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.innerHTML = `<strong>SESSION</strong> — ${esc((error as Error).message)}`;
    }
    return false;
  }
}

function isGatewayReturn(): boolean {
  const params = new URLSearchParams(location.search);
  if (params.get('verify') === '1') return true;
  if (location.pathname === '/return' || location.pathname === '/payment/callback') return true;
  const statusKeys = ['status', 'state', 'txn_status', 'payment_status', 'txnid', 'txn_id', 'order_id'];
  return statusKeys.some((key) => params.has(key));
}

function returnTxnId(): string | null {
  const params = new URLSearchParams(location.search);
  for (const key of ['txn_id', 'txnid', 'order_id', 'orderid', 'merchantTransactionId', 'merchant_order_id']) {
    const value = params.get(key);
    if (value) return value;
  }
  const match = /^\/pay\/(.+)$/.exec(location.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** After a gateway redirect: verify server-side and show the outcome. */
async function handleGatewayReturn(): Promise<VerifyResult | null> {
  if (!isGatewayReturn()) return null;

  const txnId = returnTxnId();
  if (!txnId) {
    const errorBox = $('#form-error');
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.innerHTML =
        '<strong>NO ORDER</strong> — this return URL has no order reference. Start a payment below.';
    }
    return null;
  }

  const query = new URLSearchParams(location.search);
  query.delete('verify');

  try {
    const result = await api<VerifyResult>(
      `/api/verify/${encodeURIComponent(txnId)}?${query.toString()}`,
    );
    showVerifyBanner(result);
    return result;
  } catch (error) {
    // The session may be gone (or the bridge down): still show the order page.
    const errorBox = $('#form-error');
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.innerHTML = `<strong>VERIFY</strong> — ${esc((error as Error).message)}`;
    }
    return null;
  }
}

async function boot(): Promise<void> {
  initTheme();
  prefillFromQuery();
  bindForm();
  bindInspector();
  void initHealth();

  const returning = await handleGatewayReturn();
  const resumed = await resumeFromUrl();

  if (resumed) {
    ensureTracker();
    if (returning) {
      if (returning.status === 'success' && returning.amountMatches !== false) {
        setTracker('success', returning.message);
      } else if (returning.status === 'failed') {
        setTracker('failed', returning.message);
      } else {
        setTracker('pending', returning.message);
      }
    }
    return;
  }
  if (returning) return;

  // tracker is created after the plan renders; wire it here as well
  const observer = new MutationObserver(() => {
    if (document.querySelector('[data-pay-action]')) {
      ensureTracker();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

void boot();

export { money, paisaToRupees };
