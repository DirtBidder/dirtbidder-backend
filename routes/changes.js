// Change orders: when a job needs more than the bid (hit rock, more tile, extra loads).
// 1) The hired operator requests an extra amount with a reason (+ optional photos).
// 2) The client approves (pays the extra into escrow through Stripe) or declines.
// 3) Paid change orders are held with the rest of the job and released together when the job is done.
// The fee on the extra is the bracket fee on the new total minus the fee already charged, so a job
// pays the same fee whether it was bid at the full price or reached it through change orders.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { stripeFor, isLive, FRONTEND_URL } = require('../lib/stripe');
const { feePerSide } = require('../utils/fees');
const { scanText, addFlag } = require('../lib/flags');
const notify = require('../lib/notify');
const { createCheckout, settleSession } = require('../lib/funding');

const MAX_EXTRA = 5000000;
const round2 = n => Math.round(Number(n) * 100) / 100;

module.exports = (pool, authMiddleware, ADMIN_EMAILS) => {
  // The job, its client, the hired operator, and money already committed (bid + paid change orders)
  async function jobInfo(jobId) {
    const r = await pool.query(
      `SELECT j.id, j.title, j.status, j.client_id, b.operator_id, b.amount AS bid_amount,
              (SELECT COALESCE(SUM(e.amount), 0) FROM escrow_transactions e
                 WHERE e.job_id = j.id AND e.status NOT IN ('pending_payment', 'cancelled', 'refunded', 'refund_needed', 'failed'))::float AS committed
       FROM jobs j LEFT JOIN bids b ON b.job_id = j.id AND b.status = 'accepted'
       WHERE j.id = $1`, [jobId]);
    return r.rows[0] || null;
  }
  const isAdmin = async userId => {
    const r = await pool.query('SELECT email, role FROM users WHERE id = $1', [userId]);
    const u = r.rows[0];
    return !!u && (u.role === 'owner' || ADMIN_EMAILS.includes(String(u.email || '').toLowerCase()));
  };
  // Fee on an extra amount, given what's already committed on the job
  const extraFee = (committed, extra) => round2(feePerSide(committed + extra) - feePerSide(committed));

  // Change orders on a job (client, hired operator, or admin)
  router.get('/jobs/:jobId', authMiddleware, async (req, res) => {
    try {
      const j = await jobInfo(parseInt(req.params.jobId, 10));
      if (!j) return res.status(404).json({ error: 'Job not found' });
      if (req.user.id !== j.client_id && req.user.id !== j.operator_id && !(await isAdmin(req.user.id))) return res.status(403).json({ error: 'Not your job' });
      const r = await pool.query(
        `SELECT c.*, (SELECT COALESCE(json_agg(p.token ORDER BY p.id), '[]'::json) FROM job_photos p WHERE p.change_order_id = c.id) AS photos
         FROM change_orders c WHERE c.job_id = $1 ORDER BY c.id`, [j.id]);
      res.json({ committed: j.committed, bid_amount: Number(j.bid_amount || 0), change_orders: r.rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Operator asks for more
  router.post('/jobs/:jobId', authMiddleware, async (req, res) => {
    try {
      const j = await jobInfo(parseInt(req.params.jobId, 10));
      if (!j) return res.status(404).json({ error: 'Job not found' });
      if (req.user.id !== j.operator_id) return res.status(403).json({ error: 'Only the hired operator can request a change' });
      if (j.status !== 'in_progress') return res.status(400).json({ error: 'Change requests can only be made while the job is in progress' });
      const amount = round2(req.body.amount);
      if (!(amount >= 1 && amount <= MAX_EXTRA)) return res.status(400).json({ error: 'Enter the extra amount in dollars' });
      const raw = String(req.body.reason || '').trim().slice(0, 2000);
      if (raw.length < 10) return res.status(400).json({ error: 'Explain what changed and why (a sentence or two)' });
      const open = await pool.query("SELECT id FROM change_orders WHERE job_id = $1 AND status IN ('pending', 'paying', 'processing')", [j.id]);
      if (open.rows.length) return res.status(400).json({ error: 'There is already a change request waiting on the client' });

      // Same rules as messages before hire: no contact info / payment-outside talk in the request
      const scan = scanText(raw);
      if (scan.reasons.some(x => !/^included /.test(x) && x !== 'asks to be contacted directly')) {
        addFlag(pool, { kind: 'message', userId: req.user.id, jobId: j.id, reason: 'Change request ' + scan.reasons.join(', '), details: raw });
      }
      const fee = extraFee(j.committed, amount);
      const r = await pool.query(
        `INSERT INTO change_orders (job_id, operator_id, amount, reason, client_fee, operator_fee, client_total, operator_payout, status)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 'pending') RETURNING *`,
        [j.id, req.user.id, amount, raw, fee, round2(amount + fee), round2(amount - fee)]);
      notify.changeRequested(pool, r.rows[0].id);
      res.json(r.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Photos for a change request (operator who made it). Body: { image: "data:image/jpeg;base64,..." }
  router.post('/:id/photos', authMiddleware, async (req, res) => {
    try {
      const c = await pool.query('SELECT job_id, operator_id, status FROM change_orders WHERE id = $1', [req.params.id]);
      if (!c.rows[0]) return res.status(404).json({ error: 'Change request not found' });
      if (c.rows[0].operator_id !== req.user.id) return res.status(403).json({ error: 'Not your change request' });
      if (c.rows[0].status !== 'pending') return res.status(400).json({ error: 'This change request is closed' });
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(req.body.image || '');
      if (!m) return res.status(400).json({ error: 'Photo must be a JPG, PNG or WebP image' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Photo is too large' });
      const count = await pool.query('SELECT COUNT(*)::int AS n FROM job_photos WHERE change_order_id = $1', [req.params.id]);
      if (count.rows[0].n >= 6) return res.status(400).json({ error: 'Up to 6 photos per change request' });
      const token = crypto.randomBytes(24).toString('hex');
      await pool.query(
        "INSERT INTO job_photos (job_id, token, mime, data, kind, change_order_id) VALUES ($1, $2, $3, $4, 'change', $5)",
        [c.rows[0].job_id, token, m[1], buf, req.params.id]);
      res.json({ token });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Operator withdraws a request the client hasn't answered
  router.post('/:id/cancel', authMiddleware, async (req, res) => {
    try {
      const r = await pool.query(
        "UPDATE change_orders SET status = 'withdrawn', decided_at = NOW() WHERE id = $1 AND operator_id = $2 AND status = 'pending' RETURNING id",
        [req.params.id, req.user.id]);
      if (!r.rows[0]) return res.status(400).json({ error: 'Nothing to withdraw' });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Client says no
  router.post('/:id/decline', authMiddleware, async (req, res) => {
    try {
      const c = await pool.query('SELECT c.*, j.client_id FROM change_orders c JOIN jobs j ON j.id = c.job_id WHERE c.id = $1', [req.params.id]);
      const co = c.rows[0];
      if (!co) return res.status(404).json({ error: 'Change request not found' });
      if (co.client_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
      if (!['pending', 'paying'].includes(co.status)) return res.status(400).json({ error: 'This change request was already answered' });
      const note = String(req.body.note || '').trim().slice(0, 1000) || null;
      await pool.query("UPDATE change_orders SET status = 'declined', client_note = $1, decided_at = NOW() WHERE id = $2", [note, co.id]);
      await pool.query("UPDATE escrow_transactions SET status = 'cancelled' WHERE change_order_id = $1 AND status = 'pending_payment'", [co.id]);
      notify.changeDecided(pool, co.id);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Client approves: pays the extra (+ fee) into escrow through Stripe Checkout
  router.post('/:id/approve', authMiddleware, async (req, res) => {
    try {
      const c = await pool.query(
        `SELECT c.*, j.client_id, j.status AS job_status, j.title,
                (SELECT b.id FROM bids b WHERE b.job_id = j.id AND b.status = 'accepted' LIMIT 1) AS bid_id
         FROM change_orders c JOIN jobs j ON j.id = c.job_id WHERE c.id = $1`, [req.params.id]);
      const co = c.rows[0];
      if (!co) return res.status(404).json({ error: 'Change request not found' });
      if (co.client_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
      if (!['pending', 'paying'].includes(co.status)) return res.status(400).json({ error: 'This change request was already answered' });
      if (!['in_progress', 'awaiting_release'].includes(co.job_status)) return res.status(400).json({ error: 'This job can’t take changes right now' });

      // Same Stripe mode as the job's original payment (test jobs stay in test mode)
      const orig = await pool.query(
        "SELECT test_mode FROM escrow_transactions WHERE job_id = $1 AND change_order_id IS NULL AND status NOT IN ('pending_payment', 'cancelled', 'processing', 'failed') ORDER BY id LIMIT 1", [co.job_id]);
      const testJob = orig.rows[0] ? !!orig.rows[0].test_mode : false;
      if (!testJob && !isLive) return res.status(503).json({ payments_paused: true, error: 'Payments open soon. We’ll email you when you can approve this.' });
      const stripe = stripeFor(testJob);

      // Recompute the fee against what's committed now (another change may have been paid since)
      const committed = (await jobInfo(co.job_id)).committed;
      const fee = extraFee(committed, Number(co.amount));
      const amount = Number(co.amount);
      await pool.query('UPDATE change_orders SET client_fee = $1, operator_fee = $1, client_total = $2, operator_payout = $3 WHERE id = $4',
        [fee, round2(amount + fee), round2(amount - fee), co.id]);

      if (!stripe) {
        // No Stripe at all (local testing): approve without a payment
        await pool.query("UPDATE change_orders SET status = 'approved', decided_at = NOW() WHERE id = $1", [co.id]);
        notify.changeDecided(pool, co.id);
        return res.json({ ok: true });
      }
      await pool.query("UPDATE escrow_transactions SET status = 'cancelled' WHERE change_order_id = $1 AND status = 'pending_payment'", [co.id]);
      const esc = await pool.query(
        `INSERT INTO escrow_transactions (job_id, bid_id, change_order_id, amount, client_fee, operator_fee, client_total, operator_payout, status, test_mode)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 'pending_payment', $8) RETURNING id`,
        [co.job_id, co.bid_id, co.id, amount, fee, round2(amount + fee), round2(amount - fee), testJob]);
      const session = await (async () => { try { return await createCheckout(stripe, {
        mode: 'payment',
        line_items: [
          { quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(amount * 100), product_data: { name: ('Change order: ' + (co.title || 'DirtBidder job')).slice(0, 250), description: 'Added to the job. Held in escrow until you release it' } } },
          ...(fee > 0 ? [{ quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(fee * 100), product_data: { name: 'DirtBidder service fee' } } }] : [])
        ],
        metadata: { escrow_id: String(esc.rows[0].id), change_order_id: String(co.id), job_id: String(co.job_id), client_id: String(req.user.id) },
        success_url: FRONTEND_URL + '/dirtbidder-client-dashboard.html?co_session={CHECKOUT_SESSION_ID}',
        cancel_url: FRONTEND_URL + '/dirtbidder-client-dashboard.html?co=cancelled'
      }, amount); } catch (err) {
        await pool.query("UPDATE escrow_transactions SET status = 'cancelled' WHERE id = $1", [esc.rows[0].id]);
        throw err;
      } })();
      await pool.query('UPDATE escrow_transactions SET stripe_session_id = $1 WHERE id = $2', [session.id, esc.rows[0].id]);
      await pool.query("UPDATE change_orders SET status = 'paying' WHERE id = $1", [co.id]);
      res.json({ checkout_url: session.url });
    } catch (err) {
      console.error(err);
      if (err.userMessage) return res.status(400).json({ error: err.userMessage });
      res.status(500).json({ error: 'Server error' });
    }
  });

  // After Stripe Checkout for a change order
  router.post('/confirm', authMiddleware, async (req, res) => {
    try {
      const sessionId = String(req.body.session_id || '');
      const r = await pool.query(
        `SELECT e.*, j.client_id FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id
         WHERE e.stripe_session_id = $1 AND e.change_order_id IS NOT NULL`, [sessionId]);
      const e = r.rows[0];
      if (!e) return res.status(404).json({ error: 'Payment not found' });
      if (e.client_id !== req.user.id) return res.status(403).json({ error: 'Not your payment' });
      if (e.status !== 'pending_payment') return res.json({ status: e.status });
      const stripe = stripeFor(!!e.test_mode);
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const out = await settleSession(pool, e, session);
      if (!out) return res.status(400).json({ error: 'Payment not completed' });
      if (out.error) return res.status(409).json(out);
      res.json(out); // { status: 'paid' } for card, { status: 'processing' } for bank
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
