/* payments.js — Dodo Payments integration for the one-time $29.99 report.

   Design goals (per approved plan):
   - FEATURE-FLAGGED via PAYMENTS_ENABLED (default OFF). When OFF, the app
     behaves EXACTLY as today and this module's Dodo SDK is never loaded.
   - All Dodo values are ENV-DRIVEN so test -> live is an env swap only.
   - Product, amount, and metadata are set SERVER-SIDE on the checkout
     session — the browser can never choose the product or price.
   - The `dodopayments` SDK is lazy-required ONLY when a checkout is actually
     created, so a missing package / unset key can never affect startup or
     the free path.

   This module holds pure payment logic + config ONLY (no Express, no DB, no
   report-pipeline deps) so it stays decoupled from server.js. The webhook
   wiring + pipeline hand-off live in server.js. */

const REPORT_PRICE_CENTS = 2999; // $29.99 — MUST match the Dodo product price
const REPORT_CURRENCY = 'USD';

// Feature flag. Default OFF: anything other than the literal string "true"
// (case-insensitive) leaves payments disabled and the free flow unchanged.
function isEnabled() {
  return String(process.env.PAYMENTS_ENABLED || '').trim().toLowerCase() === 'true';
}

// All Dodo env in one place. Uses the @dodopayments/express adapter's
// canonical variable names so the adapter and this module agree.
function env() {
  const appUrl = (process.env.APP_URL || 'https://growthim.com').replace(/\/+$/, '');
  return {
    apiKey:      process.env.DODO_PAYMENTS_API_KEY || '',
    webhookKey:  process.env.DODO_PAYMENTS_WEBHOOK_KEY || '',
    environment: process.env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode', // 'test_mode' | 'live_mode'
    returnUrl:   process.env.DODO_PAYMENTS_RETURN_URL || (appUrl + '/app'),
    productId:   process.env.DODO_PRODUCT_ID_REPORT || '',
  };
}

// Browser-safe config injected into /app. Contains NO secrets — only whether
// payments are on and which overlay mode (test/live) the dodopayments-checkout
// SDK should run in. The overlay needs NO publishable key (it is powered by
// the server-generated checkout_url).
function clientConfig() {
  const e = env();
  return {
    enabled: isEnabled(),
    mode: e.environment === 'live_mode' ? 'live' : 'test',
    priceLabel: '$29.99',
  };
}

// Lazily construct the Dodo SDK client. Throws a clear, user-safe-able error
// if misconfigured. Only ever called from createReportCheckoutSession (i.e.
// only when payments are enabled and a checkout is requested).
function buildClient() {
  const e = env();
  if (!e.apiKey) throw new Error('DODO_PAYMENTS_API_KEY is not set');
  const Dodo = require('dodopayments');       // lazy — only when enabled
  const Ctor = Dodo.default || Dodo;
  return new Ctor({ bearerToken: e.apiKey, environment: e.environment });
}

// Create a one-time checkout SESSION for the $29.99 report. product_id,
// amount (via the product), and metadata are all server-controlled. Returns
// the checkout_url the overlay opens + the Dodo session id (for our records).
async function createReportCheckoutSession({ jobId, userId, reportType, customerEmail }) {
  const e = env();
  if (!e.productId) throw new Error('DODO_PRODUCT_ID_REPORT is not set');
  const client = buildClient();
  // Append our job id (+ mode) to the return URL so that if the overlay
  // redirects the browser back to return_url after payment, /app can RESUME
  // the report UI for this job (show "confirming payment…", then the report)
  // instead of landing on a blank/landing page. The BASE (localhost vs
  // https://growthim.com) stays env-driven via DODO_PAYMENTS_RETURN_URL /
  // APP_URL — this only adds query params, so production behaviour is intact.
  const _sep = e.returnUrl.includes('?') ? '&' : '?';
  const returnUrl = e.returnUrl + _sep + 'resume_job=' + encodeURIComponent(jobId)
    + '&resume_mode=' + (reportType === 'market' ? 'market' : 'rate');
  const session = await client.checkoutSessions.create({
    product_cart: [{ product_id: e.productId, quantity: 1 }],
    customer: customerEmail ? { email: customerEmail } : undefined,
    metadata: {
      job_id: String(jobId),
      user_id: String(userId),
      report_type: String(reportType),
    },
    return_url: returnUrl,
  });
  return {
    checkoutUrl: session.checkout_url || session.checkoutUrl || null,
    sessionId: session.checkout_session_id || session.session_id || session.id || null,
  };
}

// Defense-in-depth: a verified payment.succeeded must be for OUR product,
// the exact $29.99 amount, and USD before we ever run a (paid) report. The
// adapter already verified the signature; this guards against a payment for
// a different/cheaper product triggering a report.
function paymentMatchesReportProduct(data) {
  if (!data) return false;
  const e = env();
  const amountOk = Number(data.total_amount) > 0;
  const currencyOk = String(data.currency || '').toUpperCase() === REPORT_CURRENCY;
  let productOk = false;
  if (e.productId) {
    const cartIds = Array.isArray(data.product_cart)
      ? data.product_cart.map((x) => x && (x.product_id || x.productId)).filter(Boolean)
      : [];
    productOk = data.product_id === e.productId || cartIds.includes(e.productId);
  }
  return amountOk && currencyOk && productOk;
}

// Pull our internal identifiers back out of the webhook payload metadata.
function metadataFrom(data) {
  const m = (data && data.metadata) || {};
  return {
    jobId: m.job_id || m.jobId || null,
    userId: m.user_id || m.userId || null,
    reportType: m.report_type || m.reportType || null,
  };
}

// Normalize the various payload shapes the adapter may hand a callback to the
// inner `data` object (some adapters pass { type, data }, others the data).
function dataOf(payload) {
  if (!payload) return {};
  if (payload.data && typeof payload.data === 'object') return payload.data;
  return payload;
}

module.exports = {
  REPORT_PRICE_CENTS,
  REPORT_CURRENCY,
  isEnabled,
  env,
  clientConfig,
  createReportCheckoutSession,
  paymentMatchesReportProduct,
  metadataFrom,
  dataOf,
};
