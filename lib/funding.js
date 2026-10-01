// Paying into escrow by card or bank account (ACH).
// Card payments are done instantly. Bank payments take about 4 business days to clear:
//   pending_payment --(client finishes checkout)--> processing --(bank clears)--> held
//                                                              \--(bank fails)---> failed
// While a hire is processing, the job is 'funding': the bid is accepted, other bids wait, and the
// operator is told not to start until it clears. If it fails, the job reopens.
// Change orders work the same way, with the change order itself moving to 'processing'.
const { stripeFor } = require('./stripe');
const { hireBid } = require('./hire');
const notify = require('./notify');

const BANK_ONLY_OVER = 10000; // jobs (or change orders) above this must be paid by bank

// Stripe caps bank (ACH) payments per payment and per week for each account. When a payment goes over,
// the client gets a clear message and the owner gets an email to ask Stripe for a higher limit.
const LIMIT_MESSAGE = 'This payment is over DirtBidder’s current bank payment limit. We’ve been notified and are getting it raised, usually within a day or two. We’ll be in touch, and your job and bids are saved.';
function isLimitError(x) {
  const t = typeof x === 'string' ? x : x ? [x.code, x.decline_code, x.message].filter(Boolean).join(' ') : '';
  return /limit/i.test(t) && /exceed|over|volume|ach|bank|debit|weekly|amount/i.test(t);
}

const bankOptions = { us_bank_account: { verification_method: 'instant', financial_connections: { permissions: ['payment_method'] } } };

// Create a Checkout session offering bank (+ card for smaller amounts)
async function createCheckout(stripe, base, jobAmount, ctx = {}) {
  const bankOnly = Number(jobAmount) > BANK_ONLY_OVER;
  try {
    return await stripe.checkout.sessions.create({
      ...base,
      payment_method_types: bankOnly ? ['us_bank_account'] : ['us_bank_account', 'card'],
      payment_method_options: bankOptions
    });
  } catch (err) {
    if (isLimitError(err)) {
      if (ctx.pool) notify.bankLimit(ctx.pool, { jobId: ctx.jobId, amount: jobAmount, stage: 'opening checkout', detail: err.message });
      const e = new Error('Bank payment limit'); e.userMessage = LIMIT_MESSAGE; throw e;
    }
    // Bank payments not switched on in this Stripe account yet
    if (!/us_bank_account|payment method/i.test(err.message || '')) throw err;
    console.error('Bank payments unavailable in Stripe:', err.message);
    if (bankOnly) {
      const e = new Error('Bank payments are not switched on in Stripe');
      e.userMessage = 'Jobs over $10,000 are paid by bank transfer, which isn’t available just yet. Please try again soon.';
      throw e;
    }
    return stripe.checkout.sessions.create({ ...base, payment_method_types: ['card'] });
  }
}

// What happened at checkout: 'succeeded' (card / cleared), 'processing' (bank started), or null (not finished)
function sessionState(session) {
  if (session.payment_status === 'paid') return 'succeeded';
  if (session.status === 'complete' && session.payment_status === 'unpaid') return 'processing';
  return null;
}
const piId = x => (typeof x === 'string' ? x : x && x.id) || null;

// ── Original hire ──
async function fundOriginal(pool, e, pi) {
  const bidR = await pool.query('SELECT * FROM bids WHERE id = $1', [e.bid_id]);
  const bid = bidR.rows[0];
  const job = (await pool.query('SELECT status FROM jobs WHERE id = $1', [e.job_id])).rows[0] || {};
  const ok = e.status === 'processing'
    ? bid && bid.status === 'accepted' && job.status === 'funding'
    : bid && bid.status === 'pending' && ['open', 'test'].includes(job.status);
  if (!ok) {
    await pool.query("UPDATE escrow_transactions SET status = 'refund_needed', stripe_payment_intent_id = $1 WHERE id = $2 AND status IN ('pending_payment', 'processing')", [pi, e.id]);
    return { status: 'refund_needed', error: 'That bid is no longer available. Your payment will be refunded.' };
  }
  const claimed = await pool.query(
    "UPDATE escrow_transactions SET status = 'held', stripe_payment_intent_id = $1 WHERE id = $2 AND status IN ('pending_payment', 'processing') RETURNING id", [pi, e.id]);
  if (!claimed.rows.length) return { status: 'held' };
  await hireBid(pool, bid);
  await pool.query("UPDATE escrow_transactions SET status = 'cancelled' WHERE job_id = $1 AND id <> $2 AND status = 'pending_payment'", [e.job_id, e.id]);
  notify.hired(pool, e.job_id);
  if (e.status === 'processing') notify.fundingCleared(pool, e.id);
  return { status: 'held' };
}

async function processingOriginal(pool, e, pi) {
  const bid = (await pool.query('SELECT * FROM bids WHERE id = $1', [e.bid_id])).rows[0];
  const job = (await pool.query('SELECT status FROM jobs WHERE id = $1', [e.job_id])).rows[0] || {};
  if (!bid || bid.status !== 'pending' || !['open', 'test'].includes(job.status)) {
    await pool.query("UPDATE escrow_transactions SET status = 'refund_needed', stripe_payment_intent_id = $1 WHERE id = $2 AND status = 'pending_payment'", [pi, e.id]);
    return { status: 'refund_needed', error: 'That bid is no longer available. Your payment will be refunded.' };
  }
  const claimed = await pool.query(
    "UPDATE escrow_transactions SET status = 'processing', stripe_payment_intent_id = $1 WHERE id = $2 AND status = 'pending_payment' RETURNING id", [pi, e.id]);
  if (!claimed.rows.length) return { status: 'processing' };
  await pool.query("UPDATE bids SET status = 'accepted' WHERE id = $1", [bid.id]);
  await pool.query("UPDATE jobs SET status = 'funding' WHERE id = $1", [e.job_id]);
  await pool.query("UPDATE escrow_transactions SET status = 'cancelled' WHERE job_id = $1 AND id <> $2 AND status = 'pending_payment'", [e.job_id, e.id]);
  notify.fundingStarted(pool, e.id);
  return { status: 'processing' };
}

async function failOriginal(pool, e) {
  const r = await pool.query("UPDATE escrow_transactions SET status = 'failed' WHERE id = $1 AND status = 'processing' RETURNING id", [e.id]);
  if (!r.rows.length) return;
  await pool.query("UPDATE bids SET status = 'pending' WHERE id = $1 AND status = 'accepted'", [e.bid_id]);
  await pool.query('UPDATE jobs SET status = $1 WHERE id = $2 AND status = $3', [e.test_mode ? 'test' : 'open', e.job_id, 'funding']);
  notify.fundingFailed(pool, e.id);
}

// ── Change orders ──
async function fundChange(pool, e, pi) {
  const co = (await pool.query('SELECT status FROM change_orders WHERE id = $1', [e.change_order_id])).rows[0];
  const job = (await pool.query('SELECT status, client_id FROM jobs WHERE id = $1', [e.job_id])).rows[0] || {};
  const lastDispute = (await pool.query('SELECT status, resolution FROM disputes WHERE job_id = $1 ORDER BY id DESC LIMIT 1', [e.job_id]).catch(() => ({ rows: [] }))).rows[0];
  const closedJob = ['cancelled', 'closed'].includes(job.status)
    || (job.status === 'completed' && lastDispute && lastDispute.status === 'resolved' && lastDispute.resolution !== 'release');
  if (!co || !['pending', 'paying', 'processing'].includes(co.status) || closedJob) {
    await pool.query("UPDATE escrow_transactions SET status = 'refund_needed', stripe_payment_intent_id = $1 WHERE id = $2 AND status IN ('pending_payment', 'processing')", [pi, e.id]);
    return { status: 'refund_needed', error: 'That change request was closed. Your payment will be refunded.' };
  }
  // Held like the rest of the job; frozen if the job is in a dispute; paid straight out if the job was already released
  const next = job.status === 'disputed' ? 'disputed' : job.status === 'completed' ? 'released' : 'held';
  const claimed = await pool.query(
    `UPDATE escrow_transactions SET status = $1, stripe_payment_intent_id = $2, released_at = CASE WHEN $1 = 'released' THEN NOW() ELSE released_at END
     WHERE id = $3 AND status IN ('pending_payment', 'processing') RETURNING id`, [next, pi, e.id]);
  if (!claimed.rows.length) return { status: 'paid' };
  await pool.query("UPDATE change_orders SET status = 'paid', decided_at = COALESCE(decided_at, NOW()), paid_at = NOW() WHERE id = $1", [e.change_order_id]);
  notify.changeDecided(pool, e.change_order_id);
  if (next === 'released') {
    const op = await pool.query('SELECT operator_id FROM change_orders WHERE id = $1', [e.change_order_id]);
    if (op.rows[0]) require('./payouts').payPendingPayouts(pool, op.rows[0].operator_id).catch(err => console.error('Payout error:', err.message));
  }
  return { status: 'paid' };
}

async function processingChange(pool, e, pi) {
  const co = (await pool.query('SELECT status FROM change_orders WHERE id = $1', [e.change_order_id])).rows[0];
  if (!co || !['pending', 'paying'].includes(co.status)) {
    await pool.query("UPDATE escrow_transactions SET status = 'refund_needed', stripe_payment_intent_id = $1 WHERE id = $2 AND status = 'pending_payment'", [pi, e.id]);
    return { status: 'refund_needed', error: 'That change request was closed. Your payment will be refunded.' };
  }
  const claimed = await pool.query(
    "UPDATE escrow_transactions SET status = 'processing', stripe_payment_intent_id = $1 WHERE id = $2 AND status = 'pending_payment' RETURNING id", [pi, e.id]);
  if (!claimed.rows.length) return { status: 'processing' };
  await pool.query("UPDATE change_orders SET status = 'processing', decided_at = COALESCE(decided_at, NOW()) WHERE id = $1", [e.change_order_id]);
  notify.changeProcessing(pool, e.change_order_id);
  return { status: 'processing' };
}

async function failChange(pool, e) {
  const r = await pool.query("UPDATE escrow_transactions SET status = 'failed' WHERE id = $1 AND status = 'processing' RETURNING id", [e.id]);
  if (!r.rows.length) return;
  await pool.query("UPDATE change_orders SET status = 'pending' WHERE id = $1 AND status = 'processing'", [e.change_order_id]);
  notify.changeFailed(pool, e.change_order_id);
}

// Apply a payment outcome to an escrow row
async function settle(pool, e, state, pi) {
  const co = !!e.change_order_id;
  if (state === 'succeeded') return co ? fundChange(pool, e, pi) : fundOriginal(pool, e, pi);
  if (state === 'processing') return co ? processingChange(pool, e, pi) : processingOriginal(pool, e, pi);
  if (state === 'failed') return co ? failChange(pool, e) : failOriginal(pool, e);
  return null;
}

// Coming back from Checkout: look at the session and apply it
async function settleSession(pool, e, session) {
  const state = sessionState(session);
  if (!state) return null;
  return settle(pool, e, state, piId(session.payment_intent));
}

// Check bank payments that are still clearing (every 15 minutes, and when a dashboard loads)
async function checkProcessing(pool, { userId = null } = {}) {
  const r = await pool.query(
    `SELECT e.* FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id
     LEFT JOIN bids b ON b.id = e.bid_id
     WHERE e.status = 'processing' AND e.stripe_payment_intent_id IS NOT NULL
       AND ($1::int IS NULL OR j.client_id = $1 OR b.operator_id = $1)`, [userId]);
  for (const e of r.rows) {
    try {
      const stripe = stripeFor(!!e.test_mode);
      if (!stripe) continue;
      const pi = await stripe.paymentIntents.retrieve(e.stripe_payment_intent_id);
      if (pi.status === 'succeeded') await settle(pool, e, 'succeeded', pi.id);
      else if (pi.status === 'requires_payment_method' || pi.status === 'canceled') {
        if (isLimitError(pi.last_payment_error)) notify.bankLimit(pool, { jobId: e.job_id, amount: e.amount, stage: 'while the payment was clearing', detail: pi.last_payment_error && pi.last_payment_error.message });
        await settle(pool, e, 'failed', pi.id);
      }
    } catch (err) {
      console.error('Bank payment check failed for escrow', e.id, '-', err.message);
    }
  }
}

// Client came back from Checkout without paying. If Stripe refused the payment over the bank limit, say so.
async function checkoutAbandoned(pool, e) {
  if (!e || e.status !== 'pending_payment' || !e.stripe_session_id) return { limit: false };
  const stripe = stripeFor(!!e.test_mode);
  if (!stripe) return { limit: false };
  const session = await stripe.checkout.sessions.retrieve(e.stripe_session_id, { expand: ['payment_intent'] });
  const pi = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
  if (pi && isLimitError(pi.last_payment_error)) {
    notify.bankLimit(pool, { jobId: e.job_id, amount: e.amount, stage: 'on the Stripe payment page', detail: pi.last_payment_error.message });
    return { limit: true, message: LIMIT_MESSAGE };
  }
  return { limit: false };
}

module.exports = { BANK_ONLY_OVER, LIMIT_MESSAGE, isLimitError, checkoutAbandoned, createCheckout, sessionState, settle, settleSession, checkProcessing };
