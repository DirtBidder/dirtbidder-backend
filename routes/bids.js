const express = require('express');
const router = express.Router();

module.exports = (pool, authMiddleware) => {
  // Submit a bid on a job (operator only)
  router.post('/:jobId/bids', authMiddleware, async (req, res) => {
    try {
      const { amount, message } = req.body;
      if (!amount) return res.status(400).json({ error: 'Amount is required' });

      const result = await pool.query(
        `INSERT INTO bids (job_id, operator_id, amount, message)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.params.jobId, req.user.id, amount, message]
      );
      res.json(result.rows[0]);
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
