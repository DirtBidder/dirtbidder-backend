const express = require('express');
const router = express.Router();

module.exports = (pool, authMiddleware, ownerOnly) => {
  // Owner dashboard stats
  router.get('/stats', authMiddleware, async (req, res) => {
    try {
      const jobCount = await pool.query('SELECT COUNT(*) FROM jobs');
      const bidCount = await pool.query('SELECT COUNT(*) FROM bids');
      const escrowHeld = await pool.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM escrow_transactions WHERE status = 'held'"
      );
      const completedCount = await pool.query("SELECT COUNT(*) FROM jobs WHERE status = 'completed'");

      res.json({
        active_jobs: parseInt(jobCount.rows[0].count),
        bids_received: parseInt(bidCount.rows[0].count),
        escrow_held: parseFloat(escrowHeld.rows[0].total),
        completed_count: parseInt(completedCount.rows[0].count)
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
