// In-app messaging between a client and an operator, one thread per (job, operator).
// Who can see a thread: the job's client, any operator who bid on the job or asked a question about it (their own thread only), and admins (read-only).
// Before the operator is hired, phone numbers / emails / links are hidden and "pay me direct" talk is flagged —
// same rules as bids. After hire, contact info goes through (they need to coordinate on site).
const express = require('express');
const router = express.Router();
const { scanText, addFlag } = require('../lib/flags');
const notify = require('../lib/notify');
const { operatorNotReady } = require('../lib/account');

module.exports = (pool, authMiddleware, ADMIN_EMAILS) => {
  const isAdmin = async userId => {
    const r = await pool.query('SELECT email, role FROM users WHERE id = $1', [userId]);
    const u = r.rows[0];
    return !!u && (u.role === 'owner' || ADMIN_EMAILS.includes(String(u.email || '').toLowerCase()));
  };

  const TEST_ACCT = /\+(test|op)\d*@/i;
  const baseEmail = e => { const [l, d] = String(e || '').toLowerCase().split('@'); return (l || '').split('+')[0] + '@' + (d || ''); };

  // Thread info + my side of it. Returns null if I'm not part of it.
  // A thread exists once the operator has bid OR has asked a question. An operator can start one on any job
  // they're allowed to see that is still taking bids, so they can ask before they price it.
  async function threadFor(userId, jobId, operatorId) {
    const r = await pool.query(
      `SELECT j.id AS job_id, j.title AS job_title, j.status AS job_status, j.client_id,
              j.site_address, j.site_lat, j.site_lng,
              (SELECT b.id FROM bids b WHERE b.job_id = j.id AND b.operator_id = $2 ORDER BY b.id DESC LIMIT 1) AS bid_id,
              (SELECT b.status FROM bids b WHERE b.job_id = j.id AND b.operator_id = $2 ORDER BY b.id DESC LIMIT 1) AS bid_status,
              (SELECT b.amount FROM bids b WHERE b.job_id = j.id AND b.operator_id = $2 ORDER BY b.id DESC LIMIT 1) AS bid_amount,
              (SELECT b.operator_id FROM bids b WHERE b.job_id = j.id AND b.status = 'accepted' LIMIT 1) AS hired_operator_id,
              EXISTS (SELECT 1 FROM messages m WHERE m.job_id = j.id AND m.operator_id = $2) AS has_messages,
              EXISTS (SELECT 1 FROM job_location_shares s WHERE s.job_id = j.id AND s.operator_id = $2) AS location_shared,
              c.name AS client_name, c.email AS client_email, o.email AS operator_email, o.role AS operator_role,
              COALESCE(NULLIF(o.company_name, ''), o.name) AS operator_name
       FROM jobs j JOIN users c ON c.id = j.client_id JOIN users o ON o.id = $2
       WHERE j.id = $1`, [jobId, operatorId]);
    const t = r.rows[0];
    if (!t) return null;
    if (userId === t.client_id) t.me = 'client';
    else if (userId === operatorId) t.me = 'operator';
    else if (await isAdmin(userId)) t.me = 'admin';
    else return null;
    const taking = ['open', 'test'].includes(t.job_status);
    if (!t.bid_id && !t.has_messages) {
      // Nothing here yet: only the operator can start it, with a question, on a job they can see
      const canSee = t.job_status === 'open'
        || (t.job_status === 'test' && (TEST_ACCT.test(t.operator_email || '') || baseEmail(t.operator_email) === baseEmail(t.client_email)));
      if (t.me !== 'operator' || t.operator_role !== 'operator' || operatorId === t.client_id || !canSee) return null;
    }
    t.operator_id = operatorId;
    t.asking = !t.bid_id; // question thread, no bid yet
    const picked = t.hired_operator_id === operatorId;
    // Contact info stays hidden until the hire is paid (a bank payment that is still clearing doesn't count yet)
    t.hired = picked && t.job_status !== 'funding';
    // Sending closes once someone else was hired, or the job was closed/cancelled without this operator
    t.can_send = t.me !== 'admin' && (picked || (!t.hired_operator_id && taking && t.bid_status !== 'withdrawn'));
    t.closed_reason = t.can_send || t.me === 'admin' ? null
      : t.hired_operator_id ? 'This job went to another operator, so this conversation is closed.'
      : t.bid_status === 'withdrawn' ? 'This bid was withdrawn, so this conversation is closed.'
      : 'This job is closed, so this conversation is closed.';
    // Job location: the operator sees it once hired and paid, or earlier if the client chose to share it with them
    const hasLocation = !!(t.site_address || (t.site_lat != null && t.site_lng != null));
    const sharedNow = t.location_shared && taking && !t.hired_operator_id;
    t.location = t.me !== 'client' && hasLocation && (t.hired || sharedNow)
      ? { address: t.site_address || null, lat: t.site_lat, lng: t.site_lng } : null;
    t.share = t.me === 'client' ? { has_location: hasLocation, shared: !!sharedNow, can_share: taking && !t.hired_operator_id } : null;
    return t;
  }

  // My conversations: one per job + operator pair where a bid or a question exists, newest activity first
  router.get('/threads', authMiddleware, async (req, res) => {
    try {
      const me = req.user.id;
      const r = await pool.query(
        `WITH pairs AS (
           SELECT DISTINCT ON (x.job_id, x.operator_id) x.job_id, x.operator_id, x.amount, x.bid_status, x.at AS bid_at
           FROM (
             SELECT b.job_id, b.operator_id, b.amount, b.status AS bid_status, b.created_at AS at, 1 AS pri, b.id AS ord FROM bids b
             UNION ALL
             SELECT m.job_id, m.operator_id, NULL::numeric, NULL::varchar, MIN(m.created_at), 0, 0 FROM messages m GROUP BY m.job_id, m.operator_id
           ) x JOIN jobs j ON j.id = x.job_id
           WHERE j.client_id = $1 OR x.operator_id = $1
           ORDER BY x.job_id, x.operator_id, x.pri DESC, x.ord DESC
         )
         SELECT p.job_id, p.operator_id, p.amount, p.bid_status, j.title AS job_title, j.status AS job_status,
                CASE WHEN j.client_id = $1 THEN 'client' ELSE 'operator' END AS me,
                CASE WHEN j.client_id = $1 THEN COALESCE(NULLIF(o.company_name, ''), o.name) ELSE c.name END AS other_name,
                lm.body AS last_body, lm.sender_id AS last_sender_id, lm.created_at AS last_at,
                (SELECT COUNT(*) FROM messages m WHERE m.job_id = p.job_id AND m.operator_id = p.operator_id
                   AND m.sender_id <> $1 AND m.read_at IS NULL)::int AS unread
         FROM pairs p JOIN jobs j ON j.id = p.job_id JOIN users c ON c.id = j.client_id JOIN users o ON o.id = p.operator_id
         LEFT JOIN LATERAL (SELECT body, sender_id, created_at FROM messages m
                            WHERE m.job_id = p.job_id AND m.operator_id = p.operator_id ORDER BY m.id DESC LIMIT 1) lm ON true
         ORDER BY COALESCE(lm.created_at, p.bid_at) DESC
         LIMIT 200`, [me]);
      res.json(r.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Unread count for the dashboard badge
  router.get('/unread', authMiddleware, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM messages m JOIN jobs j ON j.id = m.job_id
         WHERE m.read_at IS NULL AND m.sender_id <> $1 AND (j.client_id = $1 OR m.operator_id = $1)`, [req.user.id]);
      res.json({ unread: r.rows[0].n });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Open a conversation (marks the other side's messages as read)
  router.get('/:jobId/:operatorId', authMiddleware, async (req, res) => {
    try {
      const jobId = parseInt(req.params.jobId, 10), operatorId = parseInt(req.params.operatorId, 10);
      const t = await threadFor(req.user.id, jobId, operatorId);
      if (!t) return res.status(404).json({ error: 'Conversation not found' });
      const admin = t.me === 'admin';
      if (!admin) {
        await pool.query(
          'UPDATE messages SET read_at = NOW() WHERE job_id = $1 AND operator_id = $2 AND sender_id <> $3 AND read_at IS NULL',
          [jobId, operatorId, req.user.id]);
      }
      const m = await pool.query(
        `SELECT id, sender_id, body, created_at, read_at${admin ? ', original_body' : ''}
         FROM messages WHERE job_id = $1 AND operator_id = $2 ORDER BY id ASC LIMIT 1000`, [jobId, operatorId]);
      res.json({
        thread: {
          job_id: t.job_id, job_title: t.job_title, job_status: t.job_status, operator_id: t.operator_id,
          client_id: t.client_id, client_name: t.client_name, operator_name: t.operator_name,
          me: t.me, my_id: req.user.id, hired: t.hired, can_send: t.can_send, closed_reason: t.closed_reason,
          asking: t.asking, bid_amount: t.bid_amount, bid_status: t.bid_status, location: t.location, share: t.share
        },
        messages: m.rows
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Send a message
  router.post('/:jobId/:operatorId', authMiddleware, async (req, res) => {
    try {
      const jobId = parseInt(req.params.jobId, 10), operatorId = parseInt(req.params.operatorId, 10);
      const raw = String(req.body.body || '').trim().slice(0, 4000);
      if (!raw) return res.status(400).json({ error: 'Message is empty' });
      const t = await threadFor(req.user.id, jobId, operatorId);
      if (!t) return res.status(404).json({ error: 'Conversation not found' });
      if (!t.can_send) return res.status(400).json({ error: t.closed_reason || 'You can’t send messages here' });
      // An operator who isn't hired yet needs a name and a confirmed email before writing to a client
      if (t.me === 'operator' && t.hired_operator_id !== operatorId) {
        const notReady = await operatorNotReady(pool, req.user.id);
        if (notReady) return res.status(403).json({ error: notReady, not_ready: true });
      }

      // Before hire: hide contact info and flag going-around-the-platform talk. After hire: payment words still flagged.
      const scan = scanText(raw);
      let body = raw, original = null, reasons = scan.reasons;
      if (!t.hired) { body = scan.text; if (body !== raw) original = raw; }
      else reasons = reasons.filter(x => !/^included /.test(x) && x !== 'asks to be contacted directly');

      // Was the other side already sitting on an unread message here? Then skip the email (no spam).
      const prior = await pool.query(
        'SELECT COUNT(*)::int AS n FROM messages WHERE job_id = $1 AND operator_id = $2 AND sender_id = $3 AND read_at IS NULL',
        [jobId, operatorId, req.user.id]);

      const r = await pool.query(
        'INSERT INTO messages (job_id, operator_id, sender_id, body, original_body) VALUES ($1, $2, $3, $4, $5) RETURNING id, sender_id, body, created_at, read_at',
        [jobId, operatorId, req.user.id, body, original]);

      if (reasons.length) {
        addFlag(pool, { kind: 'message', userId: req.user.id, jobId,
          reason: 'Message ' + reasons.join(', '), details: raw });
      }
      if (!prior.rows[0].n) notify.newMessage(pool, r.rows[0].id);
      res.json({ message: r.rows[0], hidden: !!original });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
