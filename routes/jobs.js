const express = require('express');
const router = express.Router();

module.exports = (pool, authMiddleware) => {
  // Post a new job (client only)
  router.post('/', authMiddleware, async (req, res) => {
    try {
      const { title, description, location, job_type, acreage, timeline, budget } = req.body;
      if (!title) return res.status(400).json({ error: 'Title is required' });

      // Jobs from test accounts (emails containing "+test") are hidden from operators
      const u = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
      const isTest = u.rows[0] && /\+test/i.test(u.rows[0].email || '');
      const result = await pool.query(
        `INSERT INTO jobs (client_id, title, description, location, job_type, acreage, timeline, budget, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [req.user.id, title, description, location, job_type, acreage, timeline, budget, isTest ? 'test' : 'open']
      );
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // List jobs (client sees own, operator sees open ones)
  router.get('/', authMiddleware, async (req, res) => {
    try {
      let result;
      if (req.user.role === 'client') {
        // Include bid counts and the hired operator so the client dashboard can show real data
        result = await pool.query(
          `SELECT j.*,
             (SELECT COUNT(*) FROM bids b WHERE b.job_id = j.id)::int AS bid_count,
             (SELECT COUNT(*) FROM bids b WHERE b.job_id = j.id AND b.status = 'pending')::int AS pending_bid_count,
             ab.amount AS accepted_amount,
             ou.name AS hired_operator_name
           FROM jobs j
           LEFT JOIN bids ab ON ab.job_id = j.id AND ab.status = 'accepted'
           LEFT JOIN users ou ON ou.id = ab.operator_id
           WHERE j.client_id = $1
           ORDER BY j.created_at DESC`,
          [req.user.id]
        );
      } else {
        // Operators see open jobs. Test operators (+test emails) also see test jobs so the full flow can be tried.
        // Bid amounts stay sealed: operators only get the count and their own bid.
        const u = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
        const isTest = u.rows[0] && /\+test/i.test(u.rows[0].email || '');
        result = await pool.query(
          `SELECT j.id, j.title, j.description, j.location, j.job_type, j.acreage, j.timeline, j.budget, j.status, j.created_at,
             (SELECT COUNT(*) FROM bids b WHERE b.job_id = j.id)::int AS bid_count,
             mb.id AS my_bid_id, mb.amount AS my_bid_amount, mb.status AS my_bid_status
           FROM jobs j
           LEFT JOIN bids mb ON mb.job_id = j.id AND mb.operator_id = $1
           WHERE j.status = 'open' OR ($2::boolean AND j.status = 'test')
           ORDER BY j.created_at DESC`,
          [req.user.id, !!isTest]
        );
      }
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Bids on a job (only the client who posted it can see them)
  router.get('/:id/bids', authMiddleware, async (req, res) => {
    try {
      const job = await pool.query('SELECT client_id FROM jobs WHERE id = $1', [req.params.id]);
      if (job.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      if (job.rows[0].client_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
      const result = await pool.query(
        `SELECT b.id, b.job_id, b.amount, b.message, b.est_days, b.equipment, b.status, b.created_at,
                u.name AS operator_name
         FROM bids b LEFT JOIN users u ON u.id = b.operator_id
         WHERE b.job_id = $1 ORDER BY b.created_at DESC`,
        [req.params.id]
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Job detail
  router.get('/:id', authMiddleware, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
