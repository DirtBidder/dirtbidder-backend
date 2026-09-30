// Clients rate the operator after a job is paid out. One review per job.
const express = require('express');
const router = express.Router();
const { getReputation, nextBadge } = require('../lib/reputation');

module.exports = (pool, authMiddleware) => {
  // Leave a review: { rating: 1-5, comment }
  router.post('/jobs/:id', authMiddleware, async (req, res) => {
    try {
      const rating = parseInt(req.body.rating, 10);
      const comment = String(req.body.comment || '').trim().slice(0, 1000) || null;
      if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Pick 1 to 5 stars' });
      const j = await pool.query(
        `SELECT j.client_id, j.status, b.operator_id FROM jobs j
         LEFT JOIN bids b ON b.job_id = j.id AND b.status = 'accepted' WHERE j.id = $1`, [req.params.id]);
      const job = j.rows[0];
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (job.client_id !== req.user.id) return res.status(403).json({ error: 'Only the client who posted this job can review it' });
      if (job.status !== 'completed' || !job.operator_id) return res.status(400).json({ error: 'You can review the operator once the job is paid out' });
      const dup = await pool.query('SELECT 1 FROM reviews WHERE job_id = $1 AND reviewer_id = $2', [req.params.id, req.user.id]);
      if (dup.rows.length) return res.status(400).json({ error: 'You already reviewed this job' });
      const r = await pool.query(
        'INSERT INTO reviews (job_id, reviewer_id, reviewee_id, rating, comment) VALUES ($1, $2, $3, $4, $5) RETURNING id, rating, comment, created_at',
        [req.params.id, req.user.id, job.operator_id, rating, comment]);
      require('../lib/notify').newReview(pool, r.rows[0].id);
      res.json(r.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Public-to-logged-in view of an operator: rating, badge and their reviews
  async function operatorProfile(id) {
    const rep = (await getReputation(pool, [id]))[id];
    if (!rep) return null;
    const u = await pool.query("SELECT COALESCE(NULLIF(company_name, ''), name) AS name, created_at, profile FROM users WHERE id = $1", [id]);
    const list = await pool.query(
      `SELECT rv.rating, rv.comment, rv.created_at, j.title AS job_title, split_part(COALESCE(cu.name, ''), ' ', 1) AS reviewer
       FROM reviews rv JOIN jobs j ON j.id = rv.job_id LEFT JOIN users cu ON cu.id = rv.reviewer_id
       WHERE rv.reviewee_id = $1 ORDER BY rv.created_at DESC LIMIT 50`, [id]);
    const pr = (u.rows[0] && u.rows[0].profile) || {};
    const about = { equipment: pr.equipment || [], equipment_other: pr.equipmentOther || '', years: pr.yearsExp || '', service_radius: pr.serviceRadius || '', bio: pr.bio || '' };
    return { name: u.rows[0] && u.rows[0].name, member_since: u.rows[0] && u.rows[0].created_at, about, ...rep, reviews: list.rows };
  }

  router.get('/operator/:id', authMiddleware, async (req, res) => {
    try {
      const p = await operatorProfile(parseInt(req.params.id, 10));
      if (!p) return res.status(404).json({ error: 'Operator not found' });
      res.json(p);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // The logged-in operator's own reviews + what they need for the next badge
  router.get('/me', authMiddleware, async (req, res) => {
    try {
      const p = await operatorProfile(req.user.id);
      if (!p) return res.status(404).json({ error: 'Not found' });
      p.next_badge = nextBadge(p);
      res.json(p);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
