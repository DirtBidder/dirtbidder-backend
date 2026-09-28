const express = require('express');
const router = express.Router();

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
        // Test jobs: only +test operators, or the poster's own email aliases, can bid
        const u = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
        const mine = (u.rows[0] && u.rows[0].email) || '';
        const base = e => { const [l, d] = String(e || '').toLowerCase().split('@'); return (l || '').split('+')[0] + '@' + (d || ''); };
        if (!/\+test/i.test(mine) && base(mine) !== base(j.client_email)) return res.status(404).json({ error: 'Job not found' });
      } else if (j.status !== 'open') {
        return res.status(400).json({ error: 'This job is no longer taking bids' });
      }
      const dup = await pool.query('SELECT id FROM bids WHERE job_id = $1 AND operator_id = $2', [req.params.jobId, req.user.id]);
      if (dup.rows.length) return res.status(400).json({ error: "You've already bid on this job" });

      const result = await pool.query(
        `INSERT INTO bids (job_id, operator_id, amount, message, est_days, equipment, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING *`,
        [req.params.jobId, req.user.id, amt, message || null, isNaN(days) ? null : days, equipment || null]
      );
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
                CASE WHEN b.status = 'accepted' THEN cu.name END AS client_name
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

      await pool.query("UPDATE bids SET status = 'accepted' WHERE id = $1", [bid.id]);
      await pool.query("UPDATE bids SET status = 'declined' WHERE job_id = $1 AND id <> $2 AND status = 'pending'", [bid.job_id, bid.id]);
      await pool.query("UPDATE jobs SET status = 'in_progress' WHERE id = $1", [bid.job_id]);

      res.json({ message: 'Bid accepted' });
    } catch (err) {
      console.error(err);
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
