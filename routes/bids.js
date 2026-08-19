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

  // Accept a bid (client only)
  router.post('/:id/accept', authMiddleware, async (req, res) => {
    try {
      const bidResult = await pool.query('SELECT * FROM bids WHERE id = $1', [req.params.id]);
      if (bidResult.rows.length === 0) return res.status(404).json({ error: 'Bid not found' });

      await pool.query("UPDATE bids SET status = 'accepted' WHERE id = $1", [req.params.id]);
      await pool.query("UPDATE jobs SET status = 'in_progress' WHERE id = $1", [bidResult.rows[0].job_id]);

      res.json({ message: 'Bid accepted' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
