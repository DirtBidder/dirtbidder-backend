// Clients report an operator (e.g. "asked me to pay outside DirtBidder"). Goes to the admin's Flagged list.
const express = require('express');
const router = express.Router();
const { addFlag } = require('../lib/flags');

const REASONS = {
  off_platform: 'Asked me to pay or deal outside DirtBidder',
  contact: 'Tried to contact me outside DirtBidder before being hired',
  no_show: 'Didn’t show up or stopped responding',
  rude: 'Rude, threatening or unprofessional',
  fake: 'Fake bid or fake business',
  other: 'Something else'
};

module.exports = (pool, authMiddleware) => {
  router.post('/', authMiddleware, async (req, res) => {
    try {
      const operatorId = parseInt(req.body.operator_id, 10);
      const jobId = parseInt(req.body.job_id, 10) || null;
      const label = REASONS[req.body.reason];
      const details = String(req.body.details || '').trim().slice(0, 1500);
      if (!operatorId || !label) return res.status(400).json({ error: 'Pick what happened' });
      if (req.body.reason === 'other' && details.length < 5) return res.status(400).json({ error: 'Tell us what happened' });
      // You can only report an operator who bid on one of your jobs
      const link = await pool.query(
        'SELECT 1 FROM bids b JOIN jobs j ON j.id = b.job_id WHERE b.operator_id = $1 AND j.client_id = $2 LIMIT 1', [operatorId, req.user.id]);
      if (!link.rows.length) return res.status(403).json({ error: 'You can only report operators who bid on your jobs' });
      await addFlag(pool, { kind: 'report', userId: operatorId, reporterId: req.user.id, jobId,
        reason: 'Client report: ' + label, details: details || null });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });
  return router;
};
