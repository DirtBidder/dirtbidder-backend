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

  // All Bids: every bid on the platform, newest first. Filter by status and search by job, operator or client.
  router.get('/bids', authMiddleware, adminOnly, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const allowed = ['pending', 'accepted', 'declined', 'withdrawn'];
      const status = allowed.includes(req.query.status) ? req.query.status : '';
      const like = '%' + q.replace(/[%_]/g, m => '\\' + m) + '%';
      const r = await pool.query(
        `SELECT b.id, b.amount, b.status, b.message, b.est_days, b.equipment, b.created_at,
                j.id AS job_id, j.title AS job_title, j.status AS job_status, j.location AS job_location, j.budget AS job_budget,
                o.id AS operator_id, o.name AS operator_name, o.company_name AS operator_company, o.email AS operator_email,
                o.suspended_at AS operator_suspended,
                c.id AS client_id, c.name AS client_name, c.email AS client_email,
                (SELECT COUNT(*) FROM bids b2 WHERE b2.job_id = j.id)::int AS bids_on_job,
                (SELECT COUNT(*) FROM flags f WHERE f.user_id = o.id AND f.status = 'open')::int AS operator_open_flags
         FROM bids b
         JOIN jobs j ON j.id = b.job_id
         JOIN users o ON o.id = b.operator_id
         LEFT JOIN users c ON c.id = j.client_id
         WHERE ($1 = '' OR b.status = $1)
           AND ($2 = '' OR j.title ILIKE $3 OR j.location ILIKE $3 OR o.name ILIKE $3 OR o.company_name ILIKE $3
                OR o.email ILIKE $3 OR c.name ILIKE $3 OR c.email ILIKE $3)
         ORDER BY b.created_at DESC NULLS LAST, b.id DESC LIMIT 200`,
        [status, q, like]);
      const counts = await pool.query('SELECT status, COUNT(*)::int AS n FROM bids GROUP BY status');
      res.json({ bids: r.rows, counts: Object.fromEntries(counts.rows.map(c => [c.status || 'pending', c.n])) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Flagged list: bids/posts/profiles with contact info, client reports, suspicious patterns
  router.get('/flags', authMiddleware, adminOnly, async (req, res) => {
    try {
      const status = req.query.status === 'reviewed' ? 'reviewed' : 'open';
      const r = await pool.query(
        `SELECT f.*, u.email, u.name, u.company_name, u.role, u.suspended_at, j.title AS job_title,
                ru.name AS reporter_name, ru.email AS reporter_email,
                (SELECT COUNT(*) FROM flags f2 WHERE f2.user_id = f.user_id)::int AS total_flags,
                (SELECT COUNT(*) FROM user_warnings w WHERE w.user_id = f.user_id)::int AS warnings
         FROM flags f JOIN users u ON u.id = f.user_id
         LEFT JOIN jobs j ON j.id = f.job_id LEFT JOIN users ru ON ru.id = f.reporter_id
         WHERE f.status = $1 ORDER BY f.created_at DESC LIMIT 100`, [status]);
      res.json(r.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Mark a flag handled (after warning/suspending, or if it's nothing)
  router.post('/flags/:id/done', authMiddleware, adminOnly, async (req, res) => {
    try {
      await pool.query("UPDATE flags SET status = 'reviewed', reviewed_at = NOW() WHERE id = $1", [parseInt(req.params.id, 10)]);
      res.json({ ok: true });
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
