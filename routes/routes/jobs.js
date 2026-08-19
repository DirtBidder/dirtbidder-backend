const express = require('express');
const router = express.Router();

module.exports = (pool, authMiddleware) => {
  // Post a new job (client only)
  router.post('/', authMiddleware, async (req, res) => {
    try {
      const { title, description, location, job_type, acreage, timeline, budget } = req.body;
      if (!title) return res.status(400).json({ error: 'Title is required' });

      const result = await pool.query(
        `INSERT INTO jobs (client_id, title, description, location, job_type, acreage, timeline, budget)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.user.id, title, description, location, job_type, acreage, timeline, budget]
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
        result = await pool.query('SELECT * FROM jobs WHERE client_id = $1 ORDER BY created_at DESC', [req.user.id]);
      } else {
        result = await pool.query("SELECT * FROM jobs WHERE status = 'open' ORDER BY created_at DESC");
      }
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
