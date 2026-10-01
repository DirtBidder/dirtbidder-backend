const express = require('express');
const { scanFields, addFlag } = require('../lib/flags');
const router = express.Router();
const { stripeFor, FRONTEND_URL, isLive } = require('../lib/stripe');
const { breakdown } = require('../utils/fees');
const { createCheckout } = require('../lib/funding');
const { hireBid } = require('../lib/hire');
const notify = require('../lib/notify');

module.exports = (pool, authMiddleware) => {
  // Submit a bid on a job (operators only)
  router.post('/:jobId/bids', authMiddleware, async (req, res) => {
    try {
      if (req.user.role !== 'operator') return res.status(403).json({ error: 'Only operator accounts can bid' });
      const { amount, message, est_days, equipment } = req.body;
      const amt = Number(amount);
      if (!amt || amt <= 0) return res.status(400).json({ error: 'Enter a bid amount' });
      const days = est_days ? parseInt(est_days, 10) : null;

      const job = await pool.query(
        'SELECT j.client_id, j.status, cu.email AS client_email FROM jobs j LEFT JOIN users cu ON cu.id = j.client_id WHERE j.id = $1',
        [req.params.jobId]
      );
      if (job.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const j = job.rows[0];
      if (j.client_id === req.user.id) return res.status(400).json({ error: "You can't bid on your own job" });
      if (j.status === 'test') {
        // Test jobs: only +test / +op operators, or the poster's own email aliases, can bid
        const u = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
        const mine = (u.rows[0] && u.rows[0].email) || '';
        const base = e => { const [l, d] = String(e || '').toLowerCase().split('@'); return (l || '').split('+')[0] + '@' + (d || ''); };
        if (!/\+(test|op)\d*@/i.test(mine) && base(mine) !== base(j.client_email)) return res.status(404).json({ error: 'Job not found' });
      } else if (j.status !== 'open') {
        return res.status(400).json({ error: 'This job is no longer taking bids' });
      }
      const dup = await pool.query('SELECT id FROM bids WHERE job_id = $1 AND operator_id = $2', [req.params.jobId, req.user.id]);
      if (dup.rows.length) return res.status(400).json({ error: "You've already bid on this job" });

      // Contact info is hidden until hire; attempts to take the job off DirtBidder are flagged for the admin
      const scan = scanFields({ message: message || null, equipment: equipment || null });
      const result = await pool.query(
        `INSERT INTO bids (job_id, operator_id, amount, message, est_days, equipment, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING *`,
        [req.params.jobId, req.user.id, amt, scan.cleaned.message, isNaN(days) ? null : days, scan.cleaned.equipment]
      );
      if (scan.reasons.length) addFlag(pool, { kind: 'bid', userId: req.user.id, jobId: Number(req.params.jobId), bidId: result.rows[0].id,
        reason: 'Bid message ' + scan.reasons.join(', '), details: scan.original });
      notify.newBid(pool, result.rows[0].id);
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // The logged-in operator's bids, with the job they're on
  router.get('/mine', authMiddleware, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT b.id, b.job_id, b.amount, b.message, b.est_days, b.equipment, b.status, b.created_at,
                j.title AS job_title, j.location AS job_location, j.status AS job_status, j.timeline AS job_timeline,
                j.completed_at AS job_completed_at,
                (SELECT row_to_json(x) FROM (SELECT d.id, d.reason, d.status, d.resolution, d.operator_response, d.admin_note
                   FROM disputes d WHERE d.job_id = j.id ORDER BY d.id DESC LIMIT 1) x) AS dispute,
                CASE WHEN b.status = 'accepted' AND j.status <> 'funding' THEN cu.name END AS client_name,
                CASE WHEN b.status = 'accepted' AND j.status <> 'funding' THEN cu.phone END AS client_phone,
                CASE WHEN b.status = 'accepted' AND j.status <> 'funding' THEN j.site_address END AS job_address
         FROM bids b
         JOIN jobs j ON j.id = b.job_id
         LEFT JOIN users cu ON cu.id = j.client_id
         WHERE b.operator_id = $1
         ORDER BY b.created_at DESC`,
        [req.user.id]
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Accept a bid (only the client who posted the job)
  router.post('/:id/accept', authMiddleware, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT b.*, j.client_id, j.status AS job_status
         FROM bids b JOIN jobs j ON j.id = b.job_id WHERE b.id = $1`,
        [req.params.id]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Bid not found' });
      const bid = r.rows[0];
      if (bid.client_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
      if (!['open', 'test'].includes(bid.job_status)) return res.status(400).json({ error: 'This job already has a hired operator' });
      if (bid.status !== 'pending') return res.status(400).json({ error: 'This bid is no longer available' });

      // Until Stripe is LIVE, real jobs can't be hired (test jobs still can, so the flow can be tried).
      // The client goes on a waitlist and gets an email when payments open.
      const testJob = bid.job_status === 'test';
      const stripe = stripeFor(testJob);
      if (!testJob && !isLive) {
        const added = await pool.query(
          'INSERT INTO payment_waitlist (bid_id, user_id, job_id) VALUES ($1, $2, $3) ON CONFLICT (bid_id) DO NOTHING RETURNING id',
          [bid.id, req.user.id, bid.job_id]);
        if (added.rows.length) notify.paymentsWaitlist(pool, bid.id);
        return res.status(503).json({
          payments_paused: true,
          error: "Payments open soon. We're finishing our secure escrow setup. Your job and this bid are saved — we'll email you as soon as you can hire."
        });
      }

      // Test job but no test key (after going live, STRIPE_TEST_SECRET_KEY must be set in Railway)
      if (!stripe && testJob && isLive) return res.status(503).json({ error: 'Test payments are off. Add STRIPE_TEST_SECRET_KEY in Railway to keep testing.' });
      // Payments not set up yet: hire right away (no escrow)
      if (!stripe) {
        await hireBid(pool, bid);
        notify.hired(pool, bid.job_id);
        return res.json({ message: 'Bid accepted' });
      }

      // Escrow: client pays job + client fee through Stripe Checkout. The hire happens once payment is confirmed.
      const f = breakdown(bid.amount);
      const job = await pool.query('SELECT title FROM jobs WHERE id = $1', [bid.job_id]);
      const title = (job.rows[0] && job.rows[0].title) || 'DirtBidder job';
      const esc = await pool.query(
        `INSERT INTO escrow_transactions (job_id, bid_id, amount, client_fee, operator_fee, client_total, operator_payout, status, test_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_payment', $8) RETURNING id`,
        [bid.job_id, bid.id, f.job_amount, f.client_fee, f.operator_fee, f.client_total, f.operator_payout, testJob]
      );
      const session = await (async () => { try { return await createCheckout(stripe, {
        mode: 'payment',
        line_items: [
          { quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(f.job_amount * 100), product_data: { name: title.slice(0, 250), description: 'Held in escrow until you release it' } } },
          { quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(f.client_fee * 100), product_data: { name: 'DirtBidder service fee' } } }
        ],
        metadata: { escrow_id: String(esc.rows[0].id), bid_id: String(bid.id), job_id: String(bid.job_id), client_id: String(req.user.id) },
        success_url: FRONTEND_URL + '/dirtbidder-client-dashboard.html?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: FRONTEND_URL + '/dirtbidder-client-dashboard.html?payment=cancelled'
      }, f.job_amount); } catch (err) {
        await pool.query("UPDATE escrow_transactions SET status = 'cancelled' WHERE id = $1", [esc.rows[0].id]);
        throw err;
      } })();
      await pool.query('UPDATE escrow_transactions SET stripe_session_id = $1 WHERE id = $2', [session.id, esc.rows[0].id]);
      res.json({ checkout_url: session.url });
    } catch (err) {
      console.error(err);
      if (err.userMessage) return res.status(400).json({ error: err.userMessage });
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Decline a bid (only the client who posted the job)
  router.post('/:id/decline', authMiddleware, async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT b.status, j.client_id FROM bids b JOIN jobs j ON j.id = b.job_id WHERE b.id = $1',
        [req.params.id]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Bid not found' });
      if (r.rows[0].client_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
      if (r.rows[0].status !== 'pending') return res.status(400).json({ error: 'This bid is no longer pending' });
      await pool.query("UPDATE bids SET status = 'declined' WHERE id = $1", [req.params.id]);
      res.json({ message: 'Bid declined' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
