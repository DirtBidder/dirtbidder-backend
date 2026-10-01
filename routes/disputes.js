// Client disputes on escrowed jobs, operator responses, and DirtBidder admin decisions
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { stripeFor } = require('../lib/stripe');
const { feePerSide } = require('../utils/fees');
const { releaseJob, AUTO_RELEASE_HOURS } = require('../lib/release');
const { payPendingPayouts } = require('../lib/payouts');
const notify = require('../lib/notify');

module.exports = (pool, authMiddleware, adminOnly) => {
  // Client reports a problem: freezes the escrow until DirtBidder decides
  router.post('/jobs/:id', authMiddleware, async (req, res) => {
    try {
      const reason = String(req.body.reason || '').trim();
      if (reason.length < 10) return res.status(400).json({ error: 'Please describe the problem (at least a sentence).' });
      const j = await pool.query('SELECT client_id, status, completed_at FROM jobs WHERE id = $1', [req.params.id]);
      if (j.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const job = j.rows[0];
      if (job.client_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
      if (!['in_progress', 'awaiting_release'].includes(job.status)) return res.status(400).json({ error: 'This job can no longer be disputed' });
      if (job.status === 'awaiting_release' && job.completed_at &&
          Date.now() - new Date(job.completed_at).getTime() > AUTO_RELEASE_HOURS * 3600 * 1000) {
        return res.status(400).json({ error: 'The 72-hour window to report a problem has passed' });
      }
      const esc = await pool.query("SELECT id FROM escrow_transactions WHERE job_id = $1 AND status = 'held' ORDER BY (change_order_id IS NOT NULL), id LIMIT 1", [req.params.id]);
      if (esc.rows.length === 0) return res.status(400).json({ error: 'There is no payment held for this job' });

      const d = await pool.query(
        `INSERT INTO disputes (job_id, escrow_id, opened_by, reason, previous_job_status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [req.params.id, esc.rows[0].id, req.user.id, reason.slice(0, 4000), job.status]
      );
      await pool.query("UPDATE escrow_transactions SET status = 'disputed' WHERE job_id = $1 AND status = 'held'", [req.params.id]);
      await pool.query("UPDATE jobs SET status = 'disputed' WHERE id = $1", [req.params.id]);
      // Give the client a moment to upload photos before the admin email goes out
      setTimeout(() => notify.disputeOpened(pool, d.rows[0].id), 60 * 1000);
      res.json({ id: d.rows[0].id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Photo evidence for a dispute (client who opened it). Body: { image: "data:image/jpeg;base64,..." }
  router.post('/:id/photos', authMiddleware, async (req, res) => {
    try {
      const d = await pool.query('SELECT job_id, opened_by, status FROM disputes WHERE id = $1', [req.params.id]);
      if (d.rows.length === 0) return res.status(404).json({ error: 'Dispute not found' });
      if (d.rows[0].opened_by !== req.user.id) return res.status(403).json({ error: 'Not your dispute' });
      if (d.rows[0].status !== 'open') return res.status(400).json({ error: 'This dispute is closed' });
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(req.body.image || '');
      if (!m) return res.status(400).json({ error: 'Photo must be a JPG, PNG or WebP image' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Photo is too large' });
      const count = await pool.query('SELECT COUNT(*)::int AS n FROM job_photos WHERE dispute_id = $1', [req.params.id]);
      if (count.rows[0].n >= 10) return res.status(400).json({ error: 'Up to 10 photos per dispute' });
      const token = crypto.randomBytes(24).toString('hex');
      await pool.query(
        "INSERT INTO job_photos (job_id, token, mime, data, kind, dispute_id) VALUES ($1, $2, $3, $4, 'dispute', $5)",
        [d.rows[0].job_id, token, m[1], buf, req.params.id]
      );
      res.json({ token });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Hired operator gives their side
  router.post('/:id/respond', authMiddleware, async (req, res) => {
    try {
      const text = String(req.body.response || '').trim();
      if (text.length < 5) return res.status(400).json({ error: 'Please write your side of the story.' });
      const d = await pool.query(
        `SELECT d.status FROM disputes d JOIN bids b ON b.job_id = d.job_id AND b.status = 'accepted'
         WHERE d.id = $1 AND b.operator_id = $2`,
        [req.params.id, req.user.id]
      );
      if (d.rows.length === 0) return res.status(403).json({ error: 'Not your job' });
      if (d.rows[0].status !== 'open') return res.status(400).json({ error: 'This dispute is closed' });
      await pool.query('UPDATE disputes SET operator_response = $1, operator_responded_at = NOW() WHERE id = $2', [text.slice(0, 4000), req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Disputes on my jobs (client or hired operator)
  router.get('/mine', authMiddleware, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT d.id, d.job_id, d.reason, d.status, d.resolution, d.admin_note, d.operator_response,
                d.created_at, d.resolved_at, d.refund_amount, d.operator_amount
         FROM disputes d
         JOIN jobs j ON j.id = d.job_id
         LEFT JOIN bids b ON b.job_id = j.id AND b.status = 'accepted'
         WHERE j.client_id = $1 OR b.operator_id = $1
         ORDER BY d.created_at DESC`,
        [req.user.id]
      );
      res.json(r.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Admin (DirtBidder) ──
  router.get('/admin/all', authMiddleware, adminOnly, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT d.*, j.title AS job_title, j.location AS job_location, j.completed_at AS job_completed_at,
                cu.name AS client_name, cu.email AS client_email,
                COALESCE(NULLIF(ou.company_name, ''), ou.name) AS operator_name, ou.email AS operator_email,
                t.amount AS escrow_amount, t.client_fee, t.client_total, t.operator_fee, t.operator_payout, t.change_orders,
                (SELECT COALESCE(json_agg(p.token ORDER BY p.id), '[]'::json) FROM job_photos p WHERE p.dispute_id = d.id) AS photos
         FROM disputes d
         JOIN jobs j ON j.id = d.job_id
         JOIN users cu ON cu.id = j.client_id
         LEFT JOIN bids b ON b.job_id = j.id AND b.status = 'accepted'
         LEFT JOIN users ou ON ou.id = b.operator_id
         LEFT JOIN LATERAL (
           SELECT SUM(e.amount) AS amount, SUM(e.client_fee) AS client_fee, SUM(e.client_total) AS client_total,
                  SUM(e.operator_fee) AS operator_fee, SUM(e.operator_payout) AS operator_payout,
                  COUNT(*) FILTER (WHERE e.change_order_id IS NOT NULL)::int AS change_orders
           FROM escrow_transactions e
           WHERE e.job_id = d.job_id AND e.status NOT IN ('pending_payment', 'cancelled')
             AND (e.id = d.escrow_id OR e.change_order_id IS NOT NULL)) t ON true
         ORDER BY (d.status = 'open') DESC, d.created_at DESC
         LIMIT 200`
      );
      res.json(r.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Decide a dispute: release (operator gets paid), refund (client gets everything back), or split
  // Admin: paid jobs with money currently held (not disputed) — for cancellations both sides agreed to
  router.get('/admin/escrows', authMiddleware, adminOnly, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT e.id, e.job_id, e.created_at, j.title, j.status AS job_status,
                (SELECT SUM(x.amount) FROM escrow_transactions x WHERE x.job_id = e.job_id AND x.status = 'held') AS amount,
                (SELECT SUM(x.client_total) FROM escrow_transactions x WHERE x.job_id = e.job_id AND x.status = 'held') AS client_total,
                cu.name AS client_name, cu.email AS client_email,
                COALESCE(NULLIF(ou.company_name, ''), ou.name) AS operator_name, ou.email AS operator_email
         FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id
         JOIN users cu ON cu.id = j.client_id
         LEFT JOIN bids b ON b.id = e.bid_id LEFT JOIN users ou ON ou.id = b.operator_id
         WHERE e.status = 'held' AND e.change_order_id IS NULL ORDER BY e.created_at DESC`);
      res.json(r.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Admin: cancel a paid job both sides agreed to cancel — full refund to the client, fee included
  router.post('/admin/escrows/:id/cancel', authMiddleware, adminOnly, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM escrow_transactions WHERE id = $1', [req.params.id]);
      const e = r.rows[0];
      if (!e) return res.status(404).json({ error: 'Payment not found' });
      if (e.status !== 'held') return res.status(400).json({ error: 'This payment isn’t held anymore (it was released, refunded or is in a dispute)' });
      // Refund every held payment on the job (the original plus any paid change orders)
      const all = (await pool.query("SELECT * FROM escrow_transactions WHERE job_id = $1 AND status = 'held' ORDER BY id", [e.job_id])).rows;
      for (const x of all) {
        if (!stripeFor(!!x.test_mode) || !x.stripe_payment_intent_id) return res.status(400).json({ error: 'No card payment to refund on this job' });
      }
      let total = 0;
      for (const x of all) {
        const refund = await stripeFor(!!x.test_mode).refunds.create(
          { payment_intent: x.stripe_payment_intent_id, amount: Math.round(Number(x.client_total) * 100), metadata: { escrow_id: String(x.id), reason: 'cancelled_by_agreement' } },
          { idempotencyKey: 'cancel-refund-' + x.id });
        await pool.query("UPDATE escrow_transactions SET status = 'refunded', stripe_refund_id = $1 WHERE id = $2", [refund.id, x.id]);
        total += Number(x.client_total);
      }
      await pool.query("UPDATE change_orders SET status = 'withdrawn', decided_at = NOW() WHERE job_id = $1 AND status IN ('pending', 'paying')", [e.job_id]);
      await pool.query("UPDATE jobs SET status = 'cancelled' WHERE id = $1", [e.job_id]);
      notify.cancelledByAgreement(pool, e.job_id, Math.round(total * 100) / 100);
      res.json({ ok: true });
    } catch (err) {
      console.error('Cancel refund error:', err.message);
      res.status(500).json({ error: err.message && err.type ? 'Stripe: ' + err.message : 'Server error' });
    }
  });

  router.post('/admin/:id/resolve', authMiddleware, adminOnly, async (req, res) => {
    try {
      const { resolution, operator_amount, note } = req.body;
      if (!['release', 'refund', 'split'].includes(resolution)) return res.status(400).json({ error: 'Pick release, refund or split' });
      const r = await pool.query('SELECT * FROM disputes WHERE id = $1', [req.params.id]);
      if (r.rows.length === 0) return res.status(404).json({ error: 'Dispute not found' });
      const d = r.rows[0];
      if (d.status !== 'open') return res.status(400).json({ error: 'Already resolved' });
      // Every payment frozen on this job: the original one plus any paid change orders (oldest first)
      const esc = await pool.query(
        "SELECT * FROM escrow_transactions WHERE job_id = $1 AND status IN ('disputed', 'held') ORDER BY (change_order_id IS NOT NULL), id", [d.job_id]);
      const escrows = esc.rows;
      if (!escrows.length) return res.status(400).json({ error: 'No payment is held for this job' });
      const jobAmount = Math.round(escrows.reduce((n, e) => n + Number(e.amount), 0) * 100) / 100;
      const clientTotal = Math.round(escrows.reduce((n, e) => n + Number(e.client_total), 0) * 100) / 100;

      if (resolution === 'release') {
        await releaseJob(pool, d.job_id);
        await pool.query(
          "UPDATE disputes SET status = 'resolved', resolution = 'release', operator_amount = $1, admin_note = $2, resolved_at = NOW(), resolved_by = $3 WHERE id = $4",
          [jobAmount, note || null, req.user.id, d.id]
        );
        notify.disputeResolved(pool, d.id);
        return res.json({ ok: true });
      }

      for (const e of escrows) {
        if (!stripeFor(!!e.test_mode) || !e.stripe_payment_intent_id) return res.status(400).json({ error: 'No card payment to refund on this job' });
      }

      if (resolution === 'refund') {
        // Full refund of everything the client paid (job + change orders + client fees)
        for (const e of escrows) {
          const refund = await stripeFor(!!e.test_mode).refunds.create(
            { payment_intent: e.stripe_payment_intent_id, amount: Math.round(Number(e.client_total) * 100), metadata: { dispute_id: String(d.id), escrow_id: String(e.id) } },
            { idempotencyKey: 'dispute-refund-' + d.id + '-' + e.id }
          );
          await pool.query("UPDATE escrow_transactions SET status = 'refunded', stripe_refund_id = $1 WHERE id = $2", [refund.id, e.id]);
        }
        await pool.query("UPDATE jobs SET status = 'cancelled' WHERE id = $1", [d.job_id]);
        await pool.query(
          "UPDATE disputes SET status = 'resolved', resolution = 'refund', refund_amount = $1, operator_amount = 0, admin_note = $2, resolved_at = NOW(), resolved_by = $3 WHERE id = $4",
          [clientTotal, note || null, req.user.id, d.id]
        );
        notify.disputeResolved(pool, d.id);
        return res.json({ ok: true });
      }

      // Split: operator is paid opAmt of the total job amount; the client gets the rest of the job amount back.
      // The operator's share fills the original payment first, then change orders.
      const opAmt = Math.round(Number(operator_amount) * 100) / 100;
      if (!(opAmt > 0 && opAmt < jobAmount)) return res.status(400).json({ error: 'Operator amount must be between $0 and the job amount' });
      const refundAmt = Math.round((jobAmount - opAmt) * 100) / 100;
      const opFeeTotal = feePerSide(opAmt);
      let left = opAmt, feeLeft = opFeeTotal;
      for (let i = 0; i < escrows.length; i++) {
        const e = escrows[i], amt = Number(e.amount);
        const opPart = Math.round(Math.min(left, amt) * 100) / 100;
        left = Math.round((left - opPart) * 100) / 100;
        const refundPart = Math.round((amt - opPart) * 100) / 100;
        let refundId = null;
        if (refundPart > 0) {
          const refund = await stripeFor(!!e.test_mode).refunds.create(
            { payment_intent: e.stripe_payment_intent_id, amount: Math.round(refundPart * 100), metadata: { dispute_id: String(d.id), escrow_id: String(e.id) } },
            { idempotencyKey: 'dispute-split-' + d.id + '-' + e.id }
          );
          refundId = refund.id;
        }
        if (opPart > 0) {
          // Operator fee shared across payments in proportion to the operator's part (last one takes the rounding)
          const isLastPaid = left <= 0;
          const fee = isLastPaid ? feeLeft : Math.round(opFeeTotal * opPart / opAmt * 100) / 100;
          feeLeft = Math.round((feeLeft - fee) * 100) / 100;
          await pool.query(
            "UPDATE escrow_transactions SET operator_fee = $1, operator_payout = $2, stripe_refund_id = $3, status = 'released', released_at = NOW() WHERE id = $4",
            [fee, Math.round((opPart - fee) * 100) / 100, refundId, e.id]);
        } else {
          await pool.query("UPDATE escrow_transactions SET status = 'refunded', stripe_refund_id = $1 WHERE id = $2", [refundId, e.id]);
        }
      }
      await pool.query("UPDATE jobs SET status = 'completed', completed_at = COALESCE(completed_at, NOW()) WHERE id = $1", [d.job_id]);
      await pool.query(
        "UPDATE disputes SET status = 'resolved', resolution = 'split', refund_amount = $1, operator_amount = $2, admin_note = $3, resolved_at = NOW(), resolved_by = $4 WHERE id = $5",
        [refundAmt, opAmt, note || null, req.user.id, d.id]
      );
      const op = await pool.query("SELECT operator_id FROM bids WHERE job_id = $1 AND status = 'accepted' LIMIT 1", [d.job_id]);
      if (op.rows[0]) await payPendingPayouts(pool, op.rows[0].operator_id);
      notify.released(pool, d.job_id);
      notify.disputeResolved(pool, d.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('Resolve dispute error:', err.message);
      res.status(500).json({ error: err.message && err.type ? 'Stripe: ' + err.message : 'Server error' });
    }
  });

  return router;
};
