// Jobs paid or released in stages (see lib/stages.js).
//   GET  /api/stages/mine              stages on my jobs (client: jobs I posted; operator: jobs I'm hired on)
//   POST /api/stages/:jobId/:n/pay     client pays the next stage ('stages' plan) → Stripe Checkout
//   POST /api/stages/:jobId/:n/done    operator says a stage (not the last one) is done → client releases it, or it auto-releases in 72 hours
//   POST /api/stages/:jobId/:n/release client releases one stage (not the last one; the last stage releases with the job)
const express = require('express');
const router = express.Router();
const stagesLib = require('../lib/stages');
const { stripeFor, FRONTEND_URL, isLive } = require('../lib/stripe');
const { createCheckout } = require('../lib/funding');
const { payPendingPayouts } = require('../lib/payouts');
const notify = require('../lib/notify');

module.exports = (pool, authMiddleware) => {
  // The job, its hired operator, and whether I'm the client or the operator
  async function jobFor(jobId, userId) {
    const r = await pool.query(
      `SELECT j.id, j.title, j.status, j.client_id, j.pay_plan, j.stage_count, b.id AS bid_id, b.operator_id, b.amount AS bid_amount,
              COALESCE(j.no_operator_fee, false) AS no_op
       FROM jobs j LEFT JOIN bids b ON b.job_id = j.id AND b.status = 'accepted' WHERE j.id = $1`, [jobId]);
    const j = r.rows[0];
    if (!j) return null;
    j.me = j.client_id === userId ? 'client' : j.operator_id === userId ? 'operator' : null;
    return j;
  }
  const ACTIVE = ['in_progress', 'awaiting_release'];

  router.get('/mine', authMiddleware, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT j.id FROM jobs j LEFT JOIN bids b ON b.job_id = j.id AND b.status = 'accepted'
         WHERE j.pay_plan IN ('full_staged', 'stages') AND (j.client_id = $1 OR b.operator_id = $1)`, [req.user.id]);
      const out = [];
      for (const row of r.rows) { const s = await stagesLib.stagesFor(pool, row.id); if (s) out.push(s); }
      res.json(out);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Client pays for the next stage. Stages are paid in order, and only while the job is active.
  router.post('/:jobId/:n/pay', authMiddleware, async (req, res) => {
    try {
      const n = parseInt(req.params.n, 10);
      const j = await jobFor(parseInt(req.params.jobId, 10), req.user.id);
      if (!j) return res.status(404).json({ error: 'Job not found' });
      if (j.me !== 'client') return res.status(403).json({ error: 'Not your job' });
      if (j.pay_plan !== 'stages') return res.status(400).json({ error: 'This job isn’t paid in stages' });
      if (!ACTIVE.includes(j.status)) return res.status(400).json({ error: 'Stages can only be paid while the job is going' });
      const s = await stagesLib.stagesFor(pool, j.id);
      const stage = s && s.stages[n - 1];
      if (!stage) return res.status(400).json({ error: 'No such stage' });
      if (stage.status !== 'unpaid') return res.status(400).json({ error: 'Stage ' + n + ' is already paid' });
      const prev = s.stages[n - 2];
      if (prev && prev.status === 'unpaid') return res.status(400).json({ error: 'Pay stage ' + (n - 1) + ' first' });

      const orig = await pool.query(
        "SELECT test_mode FROM escrow_transactions WHERE job_id = $1 AND stage_n = 1 AND status NOT IN ('pending_payment', 'cancelled', 'failed') ORDER BY id LIMIT 1", [j.id]);
      const testJob = orig.rows[0] ? !!orig.rows[0].test_mode : false;
      if (!testJob && !isLive) return res.status(503).json({ error: 'Payments are paused right now. Try again soon.' });
      const stripe = stripeFor(testJob);
      if (!stripe) return res.status(503).json({ error: 'Payments are not set up yet' });

      const a = stagesLib.stageAmounts(j.bid_amount, { noOperatorFee: j.no_op })[n - 1];
      // Any earlier unfinished checkout for this stage is replaced
      await pool.query("UPDATE escrow_transactions SET status = 'cancelled' WHERE job_id = $1 AND stage_n = $2 AND status = 'pending_payment'", [j.id, n]);
      const esc = await pool.query(
        `INSERT INTO escrow_transactions (job_id, bid_id, amount, client_fee, operator_fee, client_total, operator_payout, status, test_mode, pay_plan, stage_n, stage_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_payment', $8, 'stages', $9, $10) RETURNING id`,
        [j.id, j.bid_id, a.amount, a.client_fee, a.operator_fee, a.client_total, a.operator_payout, testJob, n, s.count]);
      const escId = esc.rows[0].id;
      let session;
      try {
        session = await createCheckout(stripe, {
          mode: 'payment',
          line_items: [
            { quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(a.amount * 100), product_data: { name: ('Stage ' + n + ' of ' + s.count + ': ' + (j.title || 'DirtBidder job')).slice(0, 250), description: 'Held until you release it' } } },
            { quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(a.client_fee * 100), product_data: { name: 'DirtBidder service fee' } } }
          ],
          metadata: { escrow_id: String(escId), job_id: String(j.id), stage: String(n), client_id: String(req.user.id) },
          success_url: FRONTEND_URL + '/dirtbidder-client-dashboard.html?session_id={CHECKOUT_SESSION_ID}',
          cancel_url: FRONTEND_URL + '/dirtbidder-client-dashboard.html?payment=stage_cancelled&e=' + escId
        }, a.amount, { pool, jobId: j.id });
      } catch (err) {
        await pool.query("UPDATE escrow_transactions SET status = 'cancelled' WHERE id = $1", [escId]);
        if (err.userMessage) return res.status(400).json({ error: err.userMessage });
        throw err;
      }
      await pool.query('UPDATE escrow_transactions SET stripe_session_id = $1 WHERE id = $2', [session.id, escId]);
      res.json({ checkout_url: session.url });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Operator: this stage is done (not the last one — the last one is "Mark Job Complete")
  router.post('/:jobId/:n/done', authMiddleware, async (req, res) => {
    try {
      const n = parseInt(req.params.n, 10);
      const j = await jobFor(parseInt(req.params.jobId, 10), req.user.id);
      if (!j) return res.status(404).json({ error: 'Job not found' });
      if (j.me !== 'operator') return res.status(403).json({ error: 'You are not hired on this job' });
      if (!j.stage_count || n < 1 || n >= j.stage_count) return res.status(400).json({ error: 'Use “Mark Job Complete” for the last stage' });
      if (!ACTIVE.includes(j.status)) return res.status(400).json({ error: 'This job is not in progress' });
      const r = await pool.query(
        "UPDATE escrow_transactions SET stage_done_at = NOW() WHERE job_id = $1 AND stage_n = $2 AND status = 'held' AND stage_done_at IS NULL RETURNING id",
        [j.id, n]);
      if (!r.rows.length) {
        const s = await stagesLib.stagesFor(pool, j.id);
        const st = s && s.stages[n - 1];
        if (st && st.status === 'unpaid') return res.status(400).json({ error: 'Stage ' + n + ' hasn’t been paid yet. Don’t start it until it’s paid.' });
        if (st && st.done_at) return res.json({ ok: true, already: true });
        return res.status(400).json({ error: 'Stage ' + n + ' isn’t held right now' });
      }
      notify.stageDone(pool, r.rows[0].id);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Client releases one stage to the operator (not the last one — that's "Release" on the job)
  router.post('/:jobId/:n/release', authMiddleware, async (req, res) => {
    try {
      const n = parseInt(req.params.n, 10);
      const j = await jobFor(parseInt(req.params.jobId, 10), req.user.id);
      if (!j) return res.status(404).json({ error: 'Job not found' });
      if (j.me !== 'client') return res.status(403).json({ error: 'Not your job' });
      if (!j.stage_count || n < 1 || n >= j.stage_count) return res.status(400).json({ error: 'The last stage is released with the job' });
      if (!ACTIVE.includes(j.status)) return res.status(400).json({ error: 'This job isn’t ready for release' });
      const r = await releaseStage(pool, j.id, n);
      if (!r) return res.status(400).json({ error: 'Stage ' + n + ' isn’t held right now' });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};

// Release one stage's held money to the operator (client's button, or 72 hours after the operator said it's done)
async function releaseStage(pool, jobId, n) {
  const r = await pool.query(
    "UPDATE escrow_transactions SET status = 'released', released_at = NOW() WHERE job_id = $1 AND stage_n = $2 AND status = 'held' RETURNING id",
    [jobId, n]);
  if (!r.rows.length) return null;
  const op = await pool.query("SELECT operator_id FROM bids WHERE job_id = $1 AND status = 'accepted' LIMIT 1", [jobId]);
  if (op.rows[0]) await payPendingPayouts(pool, op.rows[0].operator_id).catch(err => console.error('Payout error:', err.message));
  notify.stageReleased(pool, r.rows[0].id);
  return r.rows[0].id;
}
module.exports.releaseStage = releaseStage;
