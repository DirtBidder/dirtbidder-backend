const express = require('express');
const router = express.Router();
const { releaseJob } = require('../lib/release');

// Email with any "+alias" removed, e.g. dwheels+test1@gmail.com -> dwheels@gmail.com (SQL expression)
const BASE_EMAIL = col => `lower(split_part(split_part(${col}, '@', 1), '+', 1) || '@' || split_part(${col}, '@', 2))`;

module.exports = (pool, authMiddleware) => {
  // Post a new job (client only)
  router.post('/', authMiddleware, async (req, res) => {
    try {
      const { title, description, location, job_type, acreage, timeline, budget } = req.body;
      const siteAddress = typeof req.body.site_address === 'string' ? req.body.site_address.trim().slice(0, 500) || null : null;
      if (!title) return res.status(400).json({ error: 'Title is required' });

      // Jobs from test accounts (emails containing "+test") are hidden from operators
      const u = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
      const isTest = u.rows[0] && /\+test/i.test(u.rows[0].email || '');
      const result = await pool.query(
        `INSERT INTO jobs (client_id, title, description, location, job_type, acreage, timeline, budget, status, site_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [req.user.id, title, description, location, job_type, acreage, timeline, budget, isTest ? 'test' : 'open', siteAddress]
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
             ab.amount AS accepted_amount, ab.operator_id AS hired_operator_id,
             (SELECT row_to_json(r) FROM (SELECT rv.rating, rv.comment FROM reviews rv WHERE rv.job_id = j.id AND rv.reviewer_id = j.client_id LIMIT 1) r) AS my_review,
             COALESCE(NULLIF(ou.company_name, ''), ou.name) AS hired_operator_name,
             (SELECT row_to_json(x) FROM (SELECT d.id, d.reason, d.status, d.resolution, d.operator_response, d.admin_note, d.created_at
                FROM disputes d WHERE d.job_id = j.id ORDER BY d.id DESC LIMIT 1) x) AS dispute,
             (SELECT COALESCE(json_agg(p.token ORDER BY p.id), '[]'::json) FROM job_photos p WHERE p.job_id = j.id AND p.kind = 'site') AS photos
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
        const myEmail = (u.rows[0] && u.rows[0].email) || '';
        const isTest = /\+test/i.test(myEmail);
        result = await pool.query(
          `SELECT j.id, j.title, j.description, j.location, j.job_type, j.acreage, j.timeline, j.budget, j.status, j.created_at,
             (SELECT COUNT(*) FROM bids b WHERE b.job_id = j.id)::int AS bid_count,
             mb.id AS my_bid_id, mb.amount AS my_bid_amount, mb.status AS my_bid_status,
             (SELECT COALESCE(json_agg(p.token ORDER BY p.id), '[]'::json) FROM job_photos p WHERE p.job_id = j.id AND p.kind = 'site') AS photos
           FROM jobs j
           LEFT JOIN bids mb ON mb.job_id = j.id AND mb.operator_id = $1
           LEFT JOIN users cu ON cu.id = j.client_id
           WHERE j.status = 'open'
              OR (j.status = 'test' AND ($2::boolean OR ${BASE_EMAIL('cu.email')} = ${BASE_EMAIL('$3')}))
           ORDER BY j.created_at DESC`,
          [req.user.id, isTest, myEmail]
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
        `SELECT b.id, b.job_id, b.amount, b.message, b.est_days, b.equipment, b.status, b.created_at, b.operator_id,
                COALESCE(NULLIF(u.company_name, ''), u.name) AS operator_name
         FROM bids b LEFT JOIN users u ON u.id = b.operator_id
         WHERE b.job_id = $1 ORDER BY b.created_at DESC`,
        [req.params.id]
      );
      const rep = await require('../lib/reputation').getReputation(pool, result.rows.map(b => b.operator_id));
      result.rows.forEach(b => { b.reputation = rep[b.operator_id] || null; });
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Add a photo to a job (only the client who posted it). Body: { image: "data:image/jpeg;base64,..." }
  router.post('/:id/photos', authMiddleware, async (req, res) => {
    try {
      const j = await pool.query('SELECT client_id FROM jobs WHERE id = $1', [req.params.id]);
      if (j.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      if (j.rows[0].client_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(req.body.image || '');
      if (!m) return res.status(400).json({ error: 'Photo must be a JPG, PNG or WebP image' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Photo is too large' });
      const count = await pool.query("SELECT COUNT(*)::int AS n FROM job_photos WHERE job_id = $1 AND kind = 'site'", [req.params.id]);
      if (count.rows[0].n >= 10) return res.status(400).json({ error: 'A job can have up to 10 photos' });
      const token = require('crypto').randomBytes(24).toString('hex');
      await pool.query('INSERT INTO job_photos (job_id, token, mime, data) VALUES ($1, $2, $3, $4)', [req.params.id, token, m[1], buf]);
      res.json({ token });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Operator marks the job done; client then releases payment
  router.post('/:id/complete', authMiddleware, async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT j.status FROM jobs j JOIN bids b ON b.job_id = j.id AND b.status = 'accepted' WHERE j.id = $1 AND b.operator_id = $2",
        [req.params.id, req.user.id]
      );
      if (r.rows.length === 0) return res.status(403).json({ error: 'You are not hired on this job' });
      if (r.rows[0].status !== 'in_progress') return res.status(400).json({ error: 'This job is not in progress' });
      await pool.query("UPDATE jobs SET status = 'awaiting_release', completed_at = NOW() WHERE id = $1", [req.params.id]);
      require('../lib/notify').markedComplete(pool, req.params.id);
      res.json({ status: 'awaiting_release' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Client confirms the work is done and releases escrow to the operator
  router.post('/:id/release', authMiddleware, async (req, res) => {
    try {
      const j = await pool.query('SELECT client_id, status FROM jobs WHERE id = $1', [req.params.id]);
      if (j.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      if (j.rows[0].client_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
      if (!['in_progress', 'awaiting_release'].includes(j.rows[0].status)) return res.status(400).json({ error: 'This job is not ready for release' });
      await releaseJob(pool, req.params.id);
      res.json({ status: 'completed' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Client takes a job down before hiring anyone (free). Pending bids are declined.
  router.post('/:id/close', authMiddleware, async (req, res) => {
    try {
      const j = await pool.query('SELECT client_id, status FROM jobs WHERE id = $1', [req.params.id]);
      if (j.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      if (j.rows[0].client_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
      if (!['open', 'test'].includes(j.rows[0].status)) return res.status(400).json({ error: 'This job already has a hired operator. Contact support@dirtbidder.com to cancel it.' });
      const pay = await pool.query("SELECT 1 FROM escrow_transactions WHERE job_id = $1 AND status IN ('held', 'pending_payment') AND stripe_payment_intent_id IS NOT NULL", [req.params.id]);
      if (pay.rows.length) return res.status(400).json({ error: 'A payment is in progress on this job. Contact support@dirtbidder.com.' });
      const declined = await pool.query("UPDATE bids SET status = 'declined' WHERE job_id = $1 AND status = 'pending' RETURNING operator_id", [req.params.id]);
      await pool.query("UPDATE jobs SET status = 'closed' WHERE id = $1", [req.params.id]);
      require('../lib/notify').jobClosed(pool, req.params.id, declined.rows.map(r => r.operator_id));
      res.json({ status: 'closed' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Client adds or changes the exact job-site address (private: only the hired operator ever sees it)
  router.put('/:id/address', authMiddleware, async (req, res) => {
    try {
      const j = await pool.query('SELECT client_id FROM jobs WHERE id = $1', [req.params.id]);
      if (j.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      if (j.rows[0].client_id !== req.user.id) return res.status(403).json({ error: 'Not your job' });
      const addr = String(req.body.site_address || '').trim().slice(0, 500) || null;
      await pool.query('UPDATE jobs SET site_address = $1 WHERE id = $2', [addr, req.params.id]);
      res.json({ site_address: addr });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Job detail. The exact address is only included for the client who posted it and the hired operator.
  router.get('/:id', authMiddleware, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const job = result.rows[0];
      if (job.client_id !== req.user.id) {
        const hired = await pool.query("SELECT 1 FROM bids WHERE job_id = $1 AND operator_id = $2 AND status = 'accepted'", [job.id, req.user.id]);
        if (hired.rows.length === 0) delete job.site_address;
      }
      res.json(job);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
