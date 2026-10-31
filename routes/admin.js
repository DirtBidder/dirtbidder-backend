// Admin: find users and suspend / restore them
const express = require('express');
const router = express.Router();
const { getReputation } = require('../lib/reputation');
const notify = require('../lib/notify');
const hq = require('../lib/hq');
const { sendEmail, SITE } = require('../lib/email');
const { isLive } = require('../lib/stripe');
const shoutouts = require('../lib/shoutouts');
const { TEST, isTestEmail, VIEW_ONLY_MSG } = require('../lib/viewer');

module.exports = (pool, authMiddleware, adminOnly, ADMIN_EMAILS) => {
  // The owner's own test accounts: +test / +op addresses of the owner's emails (dwheels7943+test1@gmail.com and so on).
  // The owner's Testing box lists them, and one tap signs the owner in as one of them. Real users' accounts can never be opened this way.
  const jwt = require('jsonwebtoken');
  const testBases = () => [...new Set([...ADMIN_EMAILS,
    ...String(process.env.OWNER_EMAILS || 'dmaxwheeler79@gmail.com,wheeler.dan.m@outlook.com').split(','),
    ...String(process.env.TEST_ACCOUNT_BASES || 'dwheels7943@gmail.com').split(',')].map(e => String(e).trim().toLowerCase()).filter(Boolean))];
  const BASE = c => `lower(split_part(split_part(${c}, '@', 1), '+', 1) || '@' || split_part(${c}, '@', 2))`;
  const TEST_WHERE = `u.email ~* '\\+(test|op)[0-9]*@' AND u.suspended_at IS NULL AND ${BASE('u.email')} = ANY($1::text[])`;

  router.get('/test-accounts', authMiddleware, adminOnly, async (req, res) => {
    try {
      if (req.user.viewer) return res.json({ accounts: [] });
      const r = await pool.query(`SELECT u.id, u.email, u.name, u.company_name, u.role FROM users u WHERE ${TEST_WHERE} ORDER BY (u.role = 'operator'), u.id`, [testBases()]);
      res.json({ accounts: r.rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/test-accounts/:id/login', authMiddleware, adminOnly, async (req, res) => {
    try {
      const r = await pool.query(`SELECT u.id, u.email, u.role FROM users u WHERE u.id = $2 AND ${TEST_WHERE}`, [testBases(), parseInt(req.params.id, 10)]);
      const u = r.rows[0];
      if (!u) return res.status(404).json({ error: 'That isn’t one of your test accounts' });
      const token = jwt.sign({ id: u.id, role: u.role }, process.env.JWT_SECRET || 'change_this_secret', { expiresIn: '12h' });
      console.log('[admin] owner', req.user.id, 'opened test account', u.id, u.email);
      res.json({ token, role: u.role, email: u.email });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Search users by name, company, email or phone. Empty search = newest 50.
  router.get('/users', authMiddleware, adminOnly, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const r = await pool.query(
        `SELECT u.id, u.email, u.name, u.company_name, u.phone, u.role, u.created_at, u.suspended_at, u.suspended_reason, COALESCE(u.internal, false) AS internal, u.email_confirmed_at, u.rules_ack_at, u.lien_ack_at, u.terms_version, u.terms_accepted_at,
           u.profile->>'featureOk' AS feature_ok, u.profile->>'featureOkAt' AS feature_ok_at,
           (SELECT COUNT(*) FROM jobs j WHERE j.client_id = u.id)::int AS jobs_posted,
           (SELECT COUNT(*) FROM bids b WHERE b.operator_id = u.id)::int AS bids_made,
           (SELECT COUNT(*) FROM disputes d JOIN jobs j ON j.id = d.job_id LEFT JOIN bids b ON b.job_id = j.id AND b.status = 'accepted'
              WHERE j.client_id = u.id OR b.operator_id = u.id)::int AS disputes,
           (SELECT COUNT(*) FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id LEFT JOIN bids b ON b.id = e.bid_id
              WHERE e.status IN ('held', 'disputed') AND (j.client_id = u.id OR b.operator_id = u.id))::int AS money_held,
           (SELECT COALESCE(json_agg(json_build_object('reason', w.reason, 'created_at', w.created_at) ORDER BY w.id DESC), '[]'::json)
              FROM user_warnings w WHERE w.user_id = u.id) AS warnings
         FROM users u
         WHERE ($1 = '' OR u.email ILIKE $2 OR u.name ILIKE $2 OR u.company_name ILIKE $2 OR u.phone ILIKE $2)
           AND (NOT $3::boolean OR ${TEST('u')})
         ORDER BY u.created_at DESC NULLS LAST, u.id DESC LIMIT 50`,
        [q, '%' + q.replace(/[%_]/g, m => '\\' + m) + '%', !!req.user.viewer]);
      const rep = await getReputation(pool, r.rows.filter(u => u.role === 'operator').map(u => u.id));
      r.rows.forEach(u => {
        u.reputation = rep[u.id] || null;
        u.is_admin = ADMIN_EMAILS.includes(String(u.email || '').toLowerCase()) || u.role === 'owner';
      });
      res.json(r.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Download operators as a CSV in the column format Meta uses for a Custom Audience (to build a lookalike).
  // Leaves out test accounts, the owner's own accounts and suspended users. Not available to the view-only login.
  router.get('/export/operators.csv', authMiddleware, adminOnly, async (req, res) => {
    try {
      if (req.user.viewer) return res.status(403).json({ error: VIEW_ONLY_MSG });
      const r = await pool.query(
        `SELECT u.email, u.name, u.phone, u.profile->>'zip' AS zip FROM users u
          WHERE u.role = 'operator' AND u.suspended_at IS NULL AND NOT COALESCE(u.internal, false)
            AND u.email !~* '\\+(test|op)[0-9]*@'
          ORDER BY u.created_at`);
      const cell = v => { const t = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim(); return /[",]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
      const lines = ['email,phone,fn,ln,zip,country'];
      for (const u of r.rows) {
        const parts = String(u.name || '').trim().split(/\s+/);
        let ph = String(u.phone || '').replace(/\D/g, '');
        if (ph.length === 10) ph = '1' + ph;
        if (ph.length !== 11) ph = '';
        const zip = String(u.zip || '').replace(/\D/g, '').slice(0, 5);
        lines.push([u.email.toLowerCase().trim(), ph, parts[0] || '', parts.length > 1 ? parts[parts.length - 1] : '', zip.length === 5 ? zip : '', 'US'].map(cell).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="dirtbidder-operators-meta.csv"');
      res.send(lines.join('\n') + '\n');
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Email a user the short "confirm your email" link (for people who signed up before confirmation existed, or who lost the email)
  const lastAdminConfirm = new Map(); // userId -> time of the last confirm link sent from the admin page
  router.post('/users/:id/send-confirm', authMiddleware, adminOnly, async (req, res) => {
    try {
      const u = (await pool.query('SELECT id, email, email_confirmed_at FROM users WHERE id = $1', [parseInt(req.params.id, 10)])).rows[0];
      if (!u) return res.status(404).json({ error: 'User not found' });
      if (u.email_confirmed_at) return res.status(400).json({ error: 'Their email is already confirmed.' });
      // A double-click sends two requests a split second apart. Only the first one sends an email.
      const last = lastAdminConfirm.get(u.id) || 0;
      if (Date.now() - last < 60000) return res.json({ sent: true, email: u.email, already: true });
      lastAdminConfirm.set(u.id, Date.now());
      notify.confirmEmail(pool, u.id);
      res.json({ sent: true, email: u.email });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Mark an account as the owner's own (left out of HQ numbers) or as a real outside user. Changes nothing else about the account.
  router.post('/users/:id/internal', authMiddleware, adminOnly, async (req, res) => {
    try {
      const r = await pool.query('UPDATE users SET internal = $1 WHERE id = $2 RETURNING id, internal', [req.body.internal === true, parseInt(req.params.id, 10)]);
      if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
      res.json(r.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Warning: emails the user the reason and keeps a record. Doesn't limit their account.
  router.post('/users/:id/warn', authMiddleware, adminOnly, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const reason = String(req.body.reason || '').trim().slice(0, 1000);
      if (reason.length < 5) return res.status(400).json({ error: 'Write what they did wrong — they will see this' });
      const u = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
      if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });
      await pool.query('INSERT INTO user_warnings (user_id, reason, created_by) VALUES ($1, $2, $3)', [id, reason, req.user.id]);
      notify.accountWarning(pool, id, reason);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Suspend: signs them out, blocks sign-in, takes down their open jobs and pulls their pending bids.
  // Records are kept (payments, taxes, disputes). Money already held is NOT touched — handle it on the Paid Jobs / Disputes tabs.
  router.post('/users/:id/suspend', authMiddleware, adminOnly, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const reason = String(req.body.reason || '').trim().slice(0, 500);
      if (!reason) return res.status(400).json({ error: 'Write a short reason — they will see it in the email' });
      const u = await pool.query('SELECT email, role FROM users WHERE id = $1', [id]);
      if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });
      if (id === req.user.id || ADMIN_EMAILS.includes(String(u.rows[0].email).toLowerCase()) || u.rows[0].role === 'owner')
        return res.status(400).json({ error: 'You can’t suspend an admin account' });
      await pool.query('UPDATE users SET suspended_at = NOW(), suspended_reason = $1 WHERE id = $2', [reason, id]);
      const jobs = await pool.query("UPDATE jobs SET status = 'closed' WHERE client_id = $1 AND status IN ('open', 'test') RETURNING id", [id]);
      if (jobs.rows.length) await pool.query("UPDATE bids SET status = 'declined' WHERE job_id = ANY($1::int[]) AND status = 'pending'", [jobs.rows.map(j => j.id)]);
      const bids = await pool.query("UPDATE bids SET status = 'withdrawn' WHERE operator_id = $1 AND status = 'pending' RETURNING id", [id]);
      console.log('[admin] suspended user', id, 'by', req.user.id);
      notify.accountSuspended(pool, id, reason);
      res.json({ ok: true, jobs_closed: jobs.rows.length, bids_pulled: bids.rows.length });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // HQ: the owner's overview — totals, money, weekly trends and recent activity.
  // Suspended accounts are left out of the client/operator totals and sign-up counts (they're shown as their own number).
  // Test accounts (+test / +op emails) and their jobs/bids/payments are left out unless ?test=1.
  router.get('/hq', authMiddleware, adminOnly, async (req, res) => {
    try {
      const viewer = !!req.user.viewer;
      const withTest = viewer || req.query.test === '1';
      // Not a real outside user: a test account (+test / +op email) or one of the owner's own accounts
      const T = a => `(${a}.email ~* '\\+(test|op)[0-9]*@' OR COALESCE(${a}.internal, false))`;
      // A view-only login sees test accounts and test jobs only, never real customers
      const realUser = viewer ? a => TEST(a) : a => `($1::boolean OR NOT ${T(a)})`;
      const realJob = viewer ? (j, c) => `(($1::boolean OR true) AND (${j}.status = 'test' OR ${TEST(c)}))`
        : (j, c) => `($1::boolean OR (${j}.status <> 'test' AND NOT COALESCE(${j}.internal, false) AND NOT ${T(c)}))`;
      const p = [withTest];

      const [users, jobs, bids, money, open, weekly, activity, hidden] = await Promise.all([
        pool.query(
          `SELECT u.role, COUNT(*) FILTER (WHERE u.suspended_at IS NULL)::int AS total,
                  COUNT(*) FILTER (WHERE u.suspended_at IS NULL AND u.created_at > NOW() - INTERVAL '7 days')::int AS new_7d,
                  COUNT(*) FILTER (WHERE u.suspended_at IS NOT NULL)::int AS suspended
           FROM users u WHERE ${realUser('u')} GROUP BY u.role`, p),
        pool.query(
          `SELECT j.status, COUNT(*)::int AS n FROM jobs j JOIN users c ON c.id = j.client_id
           WHERE ${realJob('j', 'c')} GROUP BY j.status`, p),
        pool.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE b.status = 'pending')::int AS pending,
                  COUNT(*) FILTER (WHERE b.created_at > NOW() - INTERVAL '7 days')::int AS new_7d,
                  COALESCE(AVG(b.amount), 0)::float AS avg_bid
           FROM bids b JOIN jobs j ON j.id = b.job_id JOIN users c ON c.id = j.client_id JOIN users o ON o.id = b.operator_id
           WHERE ${realJob('j', 'c')} AND ${realUser('o')}`, p),
        pool.query(
          `SELECT COALESCE(SUM(e.amount) FILTER (WHERE e.status IN ('held', 'disputed')), 0)::float AS in_escrow,
                  COUNT(*) FILTER (WHERE e.status = 'disputed')::int AS frozen,
                  COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'released'), 0)::float AS job_value_done,
                  COALESCE(SUM(COALESCE(e.client_fee, 0) + COALESCE(e.operator_fee, 0)) FILTER (WHERE e.status = 'released'), 0)::float AS fees_earned,
                  COALESCE(SUM(COALESCE(e.client_fee, 0) + COALESCE(e.operator_fee, 0)) FILTER (WHERE e.status IN ('held', 'disputed')), 0)::float AS fees_pending,
                  COALESCE(SUM(e.operator_payout) FILTER (WHERE e.status = 'released'), 0)::float AS paid_to_operators,
                  COUNT(*) FILTER (WHERE e.status IN ('refunded', 'refund_needed'))::int AS refunds
           FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id JOIN users c ON c.id = j.client_id
           WHERE ${realJob('j', 'c')}`, p),
        pool.query(viewer
          ? `SELECT (SELECT COUNT(*) FROM disputes d JOIN jobs j ON j.id = d.job_id JOIN users c ON c.id = j.client_id WHERE d.status = 'open' AND ${TEST('c')})::int AS disputes,
                    (SELECT COUNT(*) FROM flags f JOIN users u ON u.id = f.user_id WHERE f.status = 'open' AND ${TEST('u')})::int AS flags,
                    (SELECT COUNT(*) FROM payment_waitlist w JOIN users u ON u.id = w.user_id WHERE w.notified_at IS NULL AND ${TEST('u')})::int AS waiting_to_pay`
          : `SELECT (SELECT COUNT(*) FROM disputes WHERE status = 'open')::int AS disputes,
                  (SELECT COUNT(*) FROM flags WHERE status = 'open')::int AS flags,
                  (SELECT COUNT(*) FROM payment_waitlist WHERE notified_at IS NULL)::int AS waiting_to_pay`),
        pool.query(
          `WITH w AS (SELECT generate_series(date_trunc('week', NOW()) - INTERVAL '7 weeks', date_trunc('week', NOW()), INTERVAL '1 week') AS wk)
           SELECT to_char(w.wk, 'YYYY-MM-DD') AS week,
             (SELECT COUNT(*) FROM users u WHERE date_trunc('week', u.created_at) = w.wk AND u.suspended_at IS NULL AND ${realUser('u')})::int AS signups,
             (SELECT COUNT(*) FROM users u WHERE date_trunc('week', u.created_at) = w.wk AND u.suspended_at IS NULL AND u.role = 'operator' AND ${realUser('u')})::int AS op_signups,
             (SELECT COUNT(*) FROM users u WHERE date_trunc('week', u.created_at) = w.wk AND u.suspended_at IS NULL AND u.role = 'client' AND ${realUser('u')})::int AS client_signups,
             (SELECT COUNT(*) FROM jobs j JOIN users c ON c.id = j.client_id WHERE date_trunc('week', j.created_at) = w.wk AND ${realJob('j', 'c')})::int AS jobs,
             (SELECT COUNT(*) FROM bids b JOIN jobs j ON j.id = b.job_id JOIN users c ON c.id = j.client_id JOIN users o ON o.id = b.operator_id
                WHERE date_trunc('week', b.created_at) = w.wk AND ${realJob('j', 'c')} AND ${realUser('o')})::int AS bids,
             (SELECT COALESCE(SUM(e.amount), 0) FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id JOIN users c ON c.id = j.client_id
                WHERE date_trunc('week', e.created_at) = w.wk AND e.status NOT IN ('pending_payment', 'cancelled', 'processing', 'failed') AND ${realJob('j', 'c')})::float AS paid_in
           FROM w ORDER BY w.wk`, p),
        pool.query(
          `SELECT * FROM (
             SELECT 'signup' AS kind, u.created_at AS at, COALESCE(NULLIF(u.company_name, ''), u.name, u.email) AS who, u.role AS detail, NULL::numeric AS amount
               FROM users u WHERE ${realUser('u')} AND u.suspended_at IS NULL
             UNION ALL
             SELECT 'job', j.created_at, c.name, j.title, j.budget FROM jobs j JOIN users c ON c.id = j.client_id WHERE ${realJob('j', 'c')}
             UNION ALL
             SELECT 'bid', b.created_at, COALESCE(NULLIF(o.company_name, ''), o.name), j.title, b.amount
               FROM bids b JOIN jobs j ON j.id = b.job_id JOIN users c ON c.id = j.client_id JOIN users o ON o.id = b.operator_id
               WHERE ${realJob('j', 'c')} AND ${realUser('o')}
             UNION ALL
             SELECT 'payment', e.created_at, c.name, j.title, e.amount
               FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id JOIN users c ON c.id = j.client_id
               WHERE e.status NOT IN ('pending_payment', 'cancelled', 'processing', 'failed') AND ${realJob('j', 'c')}
             UNION ALL
             SELECT 'dispute', d.created_at, c.name, j.title, NULL FROM disputes d JOIN jobs j ON j.id = d.job_id JOIN users c ON c.id = j.client_id
               WHERE ${realJob('j', 'c')}
           ) a WHERE a.at IS NOT NULL ORDER BY a.at DESC LIMIT 25`, p),
        pool.query(
          `SELECT (SELECT COUNT(*) FROM users u WHERE ${T('u')})::int AS users,
                  (SELECT COUNT(*) FROM jobs j JOIN users c ON c.id = j.client_id WHERE j.status = 'test' OR ${T('c')})::int AS jobs`)
      ]);

      // Newest people, operators and clients listed separately on HQ
      const newest = await pool.query(
        `SELECT * FROM (
           SELECT u.role, u.created_at AS at, COALESCE(NULLIF(u.company_name, ''), u.name, u.email) AS who, u.profile->>'zip' AS zip, COALESCE(NULLIF(u.profile->>'zipCity', ''), NULLIF(u.profile->>'city', '')) AS town,
                  ROW_NUMBER() OVER (PARTITION BY u.role ORDER BY u.created_at DESC) AS rn
           FROM users u WHERE ${realUser('u')} AND u.suspended_at IS NULL AND u.role IN ('operator', 'client')
         ) x WHERE rn <= 10 ORDER BY at DESC`, p).catch(() => ({ rows: [] }));
      const noVisitors = { today: 0, last_7d: 0, views_7d: 0, top_referrers: [], weekly: {} };
      const visitors = viewer ? noVisitors : await hq.visitorStats(pool).catch(() => noVisitors);
      weekly.rows.forEach(w => { w.visitors = visitors.weekly[w.week] || 0; });
      delete visitors.weekly;
      const tasks = viewer ? { rows: [] } : await pool.query('SELECT id, title, done_at FROM hq_tasks ORDER BY (done_at IS NOT NULL), sort, id').catch(() => ({ rows: [] }));
      const byRole = Object.fromEntries(users.rows.map(r => [r.role, r]));
      const jobsBy = Object.fromEntries(jobs.rows.map(r => [r.status, r.n]));
      res.json({
        view_only: viewer,
        with_test: withTest,
        hidden_test: hidden.rows[0],
        users: {
          clients: (byRole.client || {}).total || 0,
          operators: (byRole.operator || {}).total || 0,
          new_7d: users.rows.reduce((n, r) => n + r.new_7d, 0),
          new_operators_7d: (byRole.operator || {}).new_7d || 0,
          new_clients_7d: (byRole.client || {}).new_7d || 0,
          suspended: users.rows.reduce((n, r) => n + r.suspended, 0)
        },
        jobs: {
          total: jobs.rows.reduce((n, r) => n + r.n, 0),
          open: (jobsBy.open || 0) + (withTest ? (jobsBy.test || 0) : 0),
          in_progress: (jobsBy.in_progress || 0) + (jobsBy.awaiting_release || 0),
          disputed: jobsBy.disputed || 0,
          completed: jobsBy.completed || 0,
          closed: (jobsBy.closed || 0) + (jobsBy.cancelled || 0)
        },
        bids: bids.rows[0],
        money: money.rows[0],
        open: open.rows[0],
        weekly: weekly.rows,
        activity: activity.rows,
        newest: {
          operators: newest.rows.filter(r => r.role === 'operator').map(({ at, who, zip, town }) => ({ at, who, zip, town })),
          clients: newest.rows.filter(r => r.role === 'client').map(({ at, who, zip, town }) => ({ at, who, zip, town }))
        },
        visitors,
        tasks: tasks.rows
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Payments waitlist: clients who tried to hire before payments were live ──
  const usd = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const waitlistRows = () => pool.query(
    `SELECT w.id, w.user_id, w.created_at, w.notified_at, u.name, u.email, j.id AS job_id, j.title, b.amount,
            COALESCE(NULLIF(o.company_name, ''), o.name) AS operator,
            (j.status = 'open' AND b.status = 'pending') AS can_hire
     FROM payment_waitlist w
     JOIN users u ON u.id = w.user_id JOIN jobs j ON j.id = w.job_id
     JOIN bids b ON b.id = w.bid_id JOIN users o ON o.id = b.operator_id
     ORDER BY w.created_at DESC LIMIT 300`);

  router.get('/waitlist', authMiddleware, adminOnly, async (req, res) => {
    try {
      const r = await waitlistRows();
      if (req.user.viewer) r.rows = r.rows.filter(x => isTestEmail(x.email));
      res.json({ live: isLive, waiting: r.rows.filter(x => !x.notified_at).length, rows: r.rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Email everyone still waiting that they can hire now (one email per client, listing their jobs)
  router.post('/waitlist/notify', authMiddleware, adminOnly, async (req, res) => {
    try {
      if (!isLive) return res.status(400).json({ error: 'Live payments aren’t on yet, so there’s nothing to announce.' });
      // Claim the rows first so a double click can't send twice
      const claimed = await pool.query('UPDATE payment_waitlist SET notified_at = NOW() WHERE notified_at IS NULL RETURNING id');
      const ids = new Set(claimed.rows.map(x => x.id));
      if (!ids.size) return res.json({ sent: 0 });
      const all = (await waitlistRows()).rows.filter(x => ids.has(x.id));
      const byUser = {};
      all.forEach(x => { (byUser[x.user_id] = byUser[x.user_id] || []).push(x); });
      let sent = 0, failed = 0;
      for (const rows of Object.values(byUser)) {
        const u = rows[0];
        const ready = rows.filter(x => x.can_hire);
        const first = String(u.name || '').trim().split(/\s+/)[0];
        const ok = await sendEmail(u.email, {
          subject: 'Payments are open on DirtBidder — you can hire now',
          heading: ready.length ? 'You can hire your operator now' : 'Payments are open on DirtBidder',
          lines: [
            `${first ? 'Hi ' + first + ', t' : 'T'}hanks for your patience. Secure payments are now live.`,
            ...ready.map(x => `• "${x.title}": ${x.operator || 'your operator'}'s ${usd(x.amount)} bid is still waiting for you.`),
            ...(ready.length ? [] : ['The bid you picked earlier is no longer open, but you can post the job again or accept another bid any time.']),
            'Your payment is held and only released when you say the job is done. Pay by bank account or card (jobs over $10,000 are paid by bank account).'
          ],
          button: { label: ready.length ? 'Review Your Bids' : 'Open Dashboard', url: SITE + '/dirtbidder-client-dashboard.html' }
        });
        if (ok) { sent++; continue; }
        // The email didn't go out, so put this client back on the list to try again
        failed++;
        for (const x of rows) await pool.query('UPDATE payment_waitlist SET notified_at = NULL WHERE id = $1', [x.id]);
      }
      res.json({ sent, failed });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // HQ to-do list
  router.post('/tasks', authMiddleware, adminOnly, async (req, res) => {
    try {
      const title = String(req.body.title || '').trim().slice(0, 300);
      if (!title) return res.status(400).json({ error: 'Type the task first' });
      const r = await pool.query('INSERT INTO hq_tasks (title, sort) VALUES ($1, (SELECT COALESCE(MAX(sort), 0) + 1 FROM hq_tasks)) RETURNING id, title, done_at', [title]);
      res.json(r.rows[0]);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
  });
  router.post('/tasks/:id/toggle', authMiddleware, adminOnly, async (req, res) => {
    try {
      const r = await pool.query('UPDATE hq_tasks SET done_at = CASE WHEN done_at IS NULL THEN NOW() ELSE NULL END WHERE id = $1 RETURNING id, title, done_at', [parseInt(req.params.id, 10)]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Task not found' });
      res.json(r.rows[0]);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
  });
  router.post('/tasks/:id/delete', authMiddleware, adminOnly, async (req, res) => {
    try {
      await pool.query('DELETE FROM hq_tasks WHERE id = $1', [parseInt(req.params.id, 10)]);
      res.json({ ok: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
  });
  // Send the morning report right now (to check what it looks like)
  router.post('/hq/report-now', authMiddleware, adminOnly, async (req, res) => {
    try { await hq.sendDailyReport(pool, { force: true }); res.json({ ok: true }); }
    catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
  });

  // All Bids: every bid on the platform, newest first. Filter by status and search by job, operator or client.
  router.get('/bids', authMiddleware, adminOnly, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const allowed = ['pending', 'accepted', 'declined', 'withdrawn'];
      const status = allowed.includes(req.query.status) ? req.query.status : '';
      const like = '%' + q.replace(/[%_]/g, m => '\\' + m) + '%';
      const r = await pool.query(
        `SELECT b.id, b.amount, b.status, b.message, b.est_days, b.equipment, b.created_at,
                j.id AS job_id, j.title AS job_title, j.status AS job_status, j.location AS job_location, j.budget AS job_budget,
                COALESCE(j.no_operator_fee, false) AS no_operator_fee, j.no_operator_fee_note,
                o.id AS operator_id, o.name AS operator_name, o.company_name AS operator_company, o.email AS operator_email,
                o.suspended_at AS operator_suspended,
                c.id AS client_id, c.name AS client_name, c.email AS client_email,
                (SELECT COUNT(*) FROM bids b2 WHERE b2.job_id = j.id)::int AS bids_on_job,
                (SELECT COUNT(*) FROM flags f WHERE f.user_id = o.id AND f.status = 'open')::int AS operator_open_flags
         FROM bids b
         JOIN jobs j ON j.id = b.job_id
         JOIN users o ON o.id = b.operator_id
         LEFT JOIN users c ON c.id = j.client_id
         WHERE ($1 = '' OR b.status = $1)
           AND ($2 = '' OR j.title ILIKE $3 OR j.location ILIKE $3 OR o.name ILIKE $3 OR o.company_name ILIKE $3
                OR o.email ILIKE $3 OR c.name ILIKE $3 OR c.email ILIKE $3)
           AND (NOT $4::boolean OR (${TEST('o')} AND ${TEST('c')}))
         ORDER BY b.created_at DESC NULLS LAST, b.id DESC LIMIT 200`,
        [status, q, like, !!req.user.viewer]);
      const counts = await pool.query(
        `SELECT b.status, COUNT(*)::int AS n FROM bids b JOIN jobs j ON j.id = b.job_id JOIN users o ON o.id = b.operator_id LEFT JOIN users c ON c.id = j.client_id
         WHERE NOT $1::boolean OR (${TEST('o')} AND ${TEST('c')}) GROUP BY b.status`, [!!req.user.viewer]);
      res.json({ bids: r.rows, counts: Object.fromEntries(counts.rows.map(c => [c.status || 'pending', c.n])) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // "Bring a customer" promo: switch the OPERATOR's fee off (or back on) for one job. The client's fee is unchanged.
  // Also fixes any payment on the job that hasn't been paid out yet, so the operator gets the full job amount.
  router.post('/jobs/:id/no-operator-fee', authMiddleware, adminOnly, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const on = req.body.on !== false;
      const note = String(req.body.note || '').trim().slice(0, 300) || null;
      const j = await pool.query('UPDATE jobs SET no_operator_fee = $1, no_operator_fee_note = $2 WHERE id = $3 RETURNING id, title', [on, on ? note : null, id]);
      if (!j.rows.length) return res.status(404).json({ error: 'Job not found' });
      const OPEN = "('pending_payment', 'processing', 'held', 'disputed')";
      const e = await pool.query(on
        ? `UPDATE escrow_transactions SET operator_fee = 0, operator_payout = amount WHERE job_id = $1 AND status IN ${OPEN} RETURNING id`
        : `UPDATE escrow_transactions SET operator_fee = client_fee, operator_payout = amount - client_fee WHERE job_id = $1 AND status IN ${OPEN} RETURNING id`, [id]);
      await pool.query(on
        ? "UPDATE change_orders SET operator_fee = 0, operator_payout = amount WHERE job_id = $1 AND status IN ('pending', 'paying')"
        : "UPDATE change_orders SET operator_fee = client_fee, operator_payout = amount - client_fee WHERE job_id = $1 AND status IN ('pending', 'paying') AND client_fee IS NOT NULL", [id]);
      console.log('[admin] operator fee', on ? 'WAIVED' : 'restored', 'on job', id, 'by', req.user.id, note ? '(' + note + ')' : '', '- payments updated:', e.rowCount);
      res.json({ ok: true, on, payments_updated: e.rowCount });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Conversations: every client/operator thread (one per job + operator), newest first, including
  // questions asked before any bid. The admin opens one read-only on the Messages page.
  router.get('/conversations', authMiddleware, adminOnly, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const like = '%' + q.replace(/[%_]/g, m => '\\' + m) + '%';
      const r = await pool.query(
        `SELECT t.job_id, t.operator_id, t.messages, t.hidden, t.last_at,
                (SELECT x.body FROM messages x WHERE x.job_id = t.job_id AND x.operator_id = t.operator_id ORDER BY x.id DESC LIMIT 1) AS last_body,
                (SELECT x.sender_id FROM messages x WHERE x.job_id = t.job_id AND x.operator_id = t.operator_id ORDER BY x.id DESC LIMIT 1) AS last_sender_id,
                j.title AS job_title, j.status AS job_status, j.location AS job_location,
                c.id AS client_id, c.name AS client_name, c.email AS client_email,
                o.name AS operator_name, o.company_name AS operator_company, o.email AS operator_email,
                (SELECT b.amount FROM bids b WHERE b.job_id = t.job_id AND b.operator_id = t.operator_id ORDER BY b.id DESC LIMIT 1) AS bid_amount,
                (SELECT b.status FROM bids b WHERE b.job_id = t.job_id AND b.operator_id = t.operator_id ORDER BY b.id DESC LIMIT 1) AS bid_status,
                EXISTS (SELECT 1 FROM job_location_shares s WHERE s.job_id = t.job_id AND s.operator_id = t.operator_id) AS location_shared
         FROM (SELECT m.job_id, m.operator_id, COUNT(*)::int AS messages,
                      COUNT(*) FILTER (WHERE m.original_body IS NOT NULL)::int AS hidden, MAX(m.created_at) AS last_at
               FROM messages m GROUP BY m.job_id, m.operator_id) t
         JOIN jobs j ON j.id = t.job_id
         JOIN users o ON o.id = t.operator_id
         LEFT JOIN users c ON c.id = j.client_id
         WHERE ($1 = '' OR j.title ILIKE $2 OR j.location ILIKE $2 OR o.name ILIKE $2 OR o.company_name ILIKE $2
                OR o.email ILIKE $2 OR c.name ILIKE $2 OR c.email ILIKE $2)
           AND (NOT $3::boolean OR (${TEST('o')} AND ${TEST('c')}))
         ORDER BY t.last_at DESC NULLS LAST LIMIT 200`, [q, like, !!req.user.viewer]);
      res.json({ conversations: r.rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Shoutouts: ready-made social media posts for operators who finished a job with 4 or 5 stars ──
  // ready = the operator said OK and it hasn't been posted; waiting = good review, but the operator hasn't said OK yet.
  // Test accounts are left out unless ?test=1.
  router.get('/shoutouts', authMiddleware, adminOnly, async (req, res) => {
    try {
      res.json({ ...(await shoutouts.list(pool, { withTest: req.user.viewer || req.query.test === '1', onlyTest: !!req.user.viewer })), facebook_url: shoutouts.FACEBOOK_URL, min_stars: shoutouts.MIN_STARS });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // The owner posted it: keep the words he used and tell the operator they were featured (one email, only the first time)
  router.post('/shoutouts/:id/posted', authMiddleware, adminOnly, async (req, res) => {
    try {
      const row = await shoutouts.one(pool, parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'That review can’t get a shoutout (it may have been refunded, or the account was suspended).' });
      if (!row.feature_ok) return res.status(400).json({ error: 'This operator hasn’t said it’s OK to feature their company, so don’t post it yet.' });
      const text = String(req.body.text || '').trim().slice(0, 3000) || row.text;
      const r = await pool.query(
        "UPDATE reviews SET shoutout_status = 'posted', shoutout_at = NOW(), shoutout_text = $1 WHERE id = $2 AND shoutout_status IS DISTINCT FROM 'posted' RETURNING id",
        [text, row.id]);
      if (r.rows.length && req.body.tell_operator !== false) notify.shoutoutPosted(pool, row.id);
      res.json({ ok: true, already: !r.rows.length });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Not posting this one (takes it off the list), or put it back
  router.post('/shoutouts/:id/skip', authMiddleware, adminOnly, async (req, res) => {
    try {
      const undo = req.body.undo === true;
      const r = await pool.query(undo
        ? "UPDATE reviews SET shoutout_status = NULL, shoutout_at = NULL WHERE id = $1 AND shoutout_status = 'skipped' RETURNING id"
        : "UPDATE reviews SET shoutout_status = 'skipped', shoutout_at = NOW() WHERE id = $1 AND shoutout_status IS NULL RETURNING id",
        [parseInt(req.params.id, 10)]);
      if (!r.rows.length) return res.status(400).json({ error: undo ? 'That one isn’t on the skipped list.' : 'That one was already posted or skipped.' });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Flagged list: bids/posts/profiles with contact info, client reports, suspicious patterns
  router.get('/flags', authMiddleware, adminOnly, async (req, res) => {
    try {
      const status = req.query.status === 'reviewed' ? 'reviewed' : 'open';
      const r = await pool.query(
        `SELECT f.*, u.email, u.name, u.company_name, u.role, u.suspended_at, j.title AS job_title,
                ru.name AS reporter_name, ru.email AS reporter_email,
                (SELECT COUNT(*) FROM flags f2 WHERE f2.user_id = f.user_id)::int AS total_flags,
                (SELECT COUNT(*) FROM user_warnings w WHERE w.user_id = f.user_id)::int AS warnings
         FROM flags f JOIN users u ON u.id = f.user_id
         LEFT JOIN jobs j ON j.id = f.job_id LEFT JOIN users ru ON ru.id = f.reporter_id
         WHERE f.status = $1 AND (NOT $2::boolean OR ${TEST('u')}) ORDER BY f.created_at DESC LIMIT 100`, [status, !!req.user.viewer]);
      res.json(r.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Mark a flag handled (after warning/suspending, or if it's nothing)
  router.post('/flags/:id/done', authMiddleware, adminOnly, async (req, res) => {
    try {
      await pool.query("UPDATE flags SET status = 'reviewed', reviewed_at = NOW() WHERE id = $1", [parseInt(req.params.id, 10)]);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Restore a suspended account (their closed jobs / pulled bids stay closed)
  router.post('/users/:id/restore', authMiddleware, adminOnly, async (req, res) => {
    try {
      await pool.query('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1', [parseInt(req.params.id, 10)]);
      console.log('[admin] restored user', req.params.id, 'by', req.user.id);
      notify.accountRestored(pool, parseInt(req.params.id, 10));
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
