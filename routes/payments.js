const express = require('express');
const router = express.Router();
const { stripe, stripeFor, isTestMode, isLive } = require('../lib/stripe');
const { settleSession, checkProcessing } = require('../lib/funding');

// Bank payments still clearing are re-checked when a dashboard loads (at most every 30s per person)
const lastCheck = new Map();

module.exports = (pool, authMiddleware) => {
  // Is escrow switched on? (front end uses this to word things)
  router.get('/status', (req, res) => res.json({ enabled: !!stripe, test_mode: isTestMode, live: isLive }));

  // After Stripe Checkout: confirm the client paid, then hire the operator and mark funds held.
  router.post('/confirm', authMiddleware, async (req, res) => {
    try {
      const { session_id } = req.body;
      if (!session_id) return res.status(400).json({ error: 'Missing session' });

      const esc = await pool.query('SELECT * FROM escrow_transactions WHERE stripe_session_id = $1', [session_id]);
      if (esc.rows.length === 0) return res.status(404).json({ error: 'Payment not found' });
      const e = esc.rows[0];
      const job = await pool.query('SELECT client_id FROM jobs WHERE id = $1', [e.job_id]);
      if (!job.rows[0] || job.rows[0].client_id !== req.user.id) return res.status(403).json({ error: 'Not your payment' });
      if (e.status !== 'pending_payment') return res.json({ status: e.status }); // already confirmed

      const stripe = stripeFor(!!e.test_mode);
      if (!stripe) return res.status(503).json({ error: 'Payments are not set up yet' });
      const session = await stripe.checkout.sessions.retrieve(session_id);
      const out = await settleSession(pool, e, session);
      if (!out) return res.status(400).json({ error: 'Payment not completed' });
      if (out.error) return res.status(409).json(out);
      res.json(out); // { status: 'held' } for card, { status: 'processing' } for bank
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Escrow records for the logged-in user (client: their jobs, operator: jobs they were hired for)
  router.get('/mine', authMiddleware, async (req, res) => {
    try {
      const now = Date.now();
      if (now - (lastCheck.get(req.user.id) || 0) > 30000) {
        lastCheck.set(req.user.id, now);
        await checkProcessing(pool, { userId: req.user.id }).catch(err => console.error('Bank check error:', err.message));
      }
      const result = await pool.query(
        `SELECT e.id, e.job_id, e.amount, e.client_fee, e.operator_fee, e.client_total, e.operator_payout,
                e.status, e.change_order_id, e.created_at, e.released_at, e.paid_out_at, (e.stripe_transfer_id IS NOT NULL) AS paid_out,
                j.title AS job_title, j.status AS job_status
         FROM escrow_transactions e
         JOIN jobs j ON j.id = e.job_id
         LEFT JOIN bids b ON b.id = e.bid_id
         WHERE e.status IN ('processing', 'held', 'released', 'refund_needed', 'disputed', 'refunded', 'failed')
           AND (j.client_id = $1 OR b.operator_id = $1)
         ORDER BY e.created_at DESC`,
        [req.user.id]
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
