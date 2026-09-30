// Admin: find users and suspend / restore them
const express = require('express');
const router = express.Router();
const { getReputation } = require('../lib/reputation');
const notify = require('../lib/notify');

module.exports = (pool, authMiddleware, adminOnly, ADMIN_EMAILS) => {
  // Search users by name, company, email or phone. Empty search = newest 50.
  router.get('/users', authMiddleware, adminOnly, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const r = await pool.query(
        `SELECT u.id, u.email, u.name, u.company_name, u.phone, u.role, u.created_at, u.suspended_at, u.suspended_reason,
           (SELECT COUNT(*) FROM jobs j WHERE j.client_id = u.id)::int AS jobs_posted,
           (SELECT COUNT(*) FROM bids b WHERE b.operator_id = u.id)::int AS bids_made,
           (SELECT COUNT(*) FROM disputes d JOIN jobs j ON j.id = d.job_id LEFT JOIN bids b ON b.job_id = j.id AND b.status = 'accepted'
              WHERE j.client_id = u.id OR b.operator_id = u.id)::int AS disputes,
           (SELECT COUNT(*) FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id LEFT JOIN bids b ON b.id = e.bid_id
              WHERE e.status IN ('held', 'disputed') AND (j.client_id = u.id OR b.operator_id = u.id))::int AS money_held,
           (SELECT COALESCE(json_agg(json_build_object('reason', w.reason, 'created_at', w.created_at) ORDER BY w.id DESC), '[]'::json)
              FROM user_warnings w WHERE w.user_id = u.id) AS warnings
         FROM users u
         WHERE $1 = '' OR u.email ILIKE $2 OR u.name ILIKE $2 OR u.company_name ILIKE $2 OR u.phone ILIKE $2
         ORDER BY u.created_at DESC NULLS LAST, u.id DESC LIMIT 50`,
        [q, '%' + q.replace(/[%_]/g, m => '\\' + m) + '%']);
      const rep = await getReputation(pool, r.rows.filter(u => u.role === 'operator').map(u => u.id));
      r.rows.forEach(u => {
        u.reputation = rep[u.id] || null;
        u.is_admin = ADMIN_EMAILS.includes(String(u.email || '').toLowerCase()) || u.role === 'owner';
      });
      res.json(r.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Warning: emails the user the reason and keeps a record. Doesn't limit their account.
  router.post('/users/:id/warn', authMiddleware, adminOnly, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const reason = String(req.body.reason || '').trim().slice(0, 1000);
      if (reason.length < 5) return res.status(400).json({ error: 'Write what they did wrong — they will see this' });
      const u = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
      if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });
      await pool.query('INSERT INTO user_warnings (user_id, reason, created_by) VALUES ($1, $2, $3)', [id, reason, req.user.id]);
      notify.accountWarning(pool, id, reason);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Suspend: signs them out, blocks sign-in, takes down their open jobs and pulls their pending bids.
  // Records are kept (payments, taxes, disputes). Money already in escrow is NOT touched — handle it on the Paid Jobs / Disputes tabs.
  router.post('/users/:id/suspend', authMiddleware, adminOnly, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const reason = String(req.body.reason || '').trim().slice(0, 500);
      if (!reason) return res.status(400).json({ error: 'Write a short reason — they will see it in the email' });
      const u = await pool.query('SELECT email, role FROM users WHERE id = $1', [id]);
      if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });
      if (id === req.user.id || ADMIN_EMAILS.includes(String(u.rows[0].email).toLowerCase()) || u.rows[0].role === 'owner')
        return res.status(400).json({ error: 'You can’t suspend an admin account' });
      await pool.query('UPDATE users SET suspended_at = NOW(), suspended_reason = $1 WHERE id = $2', [reason, id]);
      const jobs = await pool.query("UPDATE jobs SET status = 'closed' WHERE client_id = $1 AND status IN ('open', 'test') RETURNING id", [id]);
      if (jobs.rows.length) await pool.query("UPDATE bids SET status = 'declined' WHERE job_id = ANY($1::int[]) AND status = 'pending'", [jobs.rows.map(j => j.id)]);
      const bids = await pool.query("UPDATE bids SET status = 'withdrawn' WHERE operator_id = $1 AND status = 'pending' RETURNING id", [id]);
      console.log('[admin] suspended user', id, 'by', req.user.id);
      notify.accountSuspended(pool, id, reason);
      res.json({ ok: true, jobs_closed: jobs.rows.length, bids_pulled: bids.rows.length });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Restore a suspended account (their closed jobs / pulled bids stay closed)
  router.post('/users/:id/restore', authMiddleware, adminOnly, async (req, res) => {
    try {
      await pool.query('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1', [parseInt(req.params.id, 10)]);
      console.log('[admin] restored user', req.params.id, 'by', req.user.id);
      notify.accountRestored(pool, parseInt(req.params.id, 10));
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
