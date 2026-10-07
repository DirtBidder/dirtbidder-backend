const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const notify = require('./lib/notify');
const { fakeSignup } = require('./lib/signupCheck');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' })); // room for one resized job photo per request

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Date of the Terms of Service / Privacy Policy users agree to at signup
const TERMS_VERSION = '2026-10-06';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';

// Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { password, phone, role, profile } = req.body;
    const email = String(req.body.email || '').trim();
    const name = String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 255);
    const companyName = profile && typeof profile.companyName === 'string' ? profile.companyName.trim().slice(0, 255) : null;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!name) return res.status(400).json({ error: 'Please enter your name' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'That email address doesn’t look right. Check it and try again.' });
    const fake = fakeSignup({ name, phone, email });
    if (fake) {
      console.log('[signup refused]', fake.field, '-', fake.field === 'email' ? email.split('@').pop() : fake.field === 'name' ? name : String(phone));
      return res.status(400).json({ error: fake.error, field: fake.field });
    }

    const existing = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered' });

    // "Feature my company" (shoutouts): kept only as a clear yes from an operator, with the date. Anything else is left unanswered.
    if (profile && typeof profile === 'object') {
      if (role === 'operator' && profile.featureOk === true) profile.featureOkAt = new Date().toISOString();
      else { delete profile.featureOk; delete profile.featureOkAt; }
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, role, name, phone, company_name, profile, terms_accepted_at, terms_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, email, role, name',
      [email, hash, role === 'operator' ? 'operator' : 'client', name, phone, companyName || null, profile ? JSON.stringify(profile) : null,
       req.body.accepted_terms === true ? new Date() : null, req.body.accepted_terms === true ? TERMS_VERSION : null]
    );

    const user = result.rows[0];
    if (req.body.accepted_terms === true) pool.query('INSERT INTO terms_acceptances (user_id, version) VALUES ($1, $2)', [user.id, TERMS_VERSION]).catch(e => console.error('terms record:', e.message));
    notify.confirmEmail(pool, user.id, { welcome: true }); // welcome note + "confirm your email" link, so typos and fake addresses show up
    notify.newSignup(pool, user.id); // tell the owner
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1) ORDER BY id LIMIT 1', [String(email || '').trim()]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
    if (user.suspended_at) return res.status(403).json({ error: SUSPENDED_MSG, suspended: true });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Auth middleware
const SUSPENDED_MSG = 'This account has been suspended. If you think this is a mistake, email support@dirtbidder.com.';
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); } catch (err) { return res.status(401).json({ error: 'Invalid token' }); }
  try {
    // Suspended accounts are signed out everywhere, right away
    const u = await pool.query('SELECT suspended_at FROM users WHERE id = $1', [decoded.id]);
    if (!u.rows[0]) return res.status(401).json({ error: 'Account not found' });
    if (u.rows[0].suspended_at) return res.status(401).json({ error: SUSPENDED_MSG, suspended: true });
  } catch (err) {
    if (err.code !== '42703') return res.status(500).json({ error: 'Server error' }); // 42703: column not added yet (first seconds after a deploy)
  }
  req.user = decoded;
  next();
}

// DirtBidder admins (by email). Set ADMIN_EMAILS in Railway to change; comma-separated.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'daniel@dirtbidder.com').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
async function adminOnly(req, res, next) {
  try {
    const r = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    const email = ((r.rows[0] && r.rows[0].email) || '').toLowerCase();
    if (req.user.role === 'owner' || ADMIN_EMAILS.includes(email)) return next();
    res.status(403).json({ error: 'Admin access only' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
}

// Owner-only middleware
function ownerOnly(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access only' });
  next();
}
// Current logged-in user
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, role, name, phone, company_name, profile, (email_confirmed_at IS NOT NULL) AS email_confirmed, (rules_ack_at IS NOT NULL) AS rules_ack, terms_version FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    // Have they agreed to the Terms as they stand today? If not, the dashboard asks them to (once per version).
    result.rows[0].terms_current = result.rows[0].terms_version === TERMS_VERSION;
    result.rows[0].terms_version_current = TERMS_VERSION;
    result.rows[0].is_admin = result.rows[0].role === 'owner' || ADMIN_EMAILS.includes(String(result.rows[0].email || '').toLowerCase());
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Agree to the current Terms of Service and Privacy Policy (asked again whenever TERMS_VERSION changes).
// Every acceptance is kept with its date and version in terms_acceptances.
app.post('/api/me/terms', authMiddleware, async (req, res) => {
  try {
    if (req.body.agree !== true) return res.status(400).json({ error: 'Tap “I agree” to continue.' });
    // The page says which version it showed. If the Terms changed again since, don't record an agreement to text they didn't see.
    if (req.body.version && req.body.version !== TERMS_VERSION) return res.status(409).json({ error: 'The Terms were just updated again. Refresh the page to see the latest version.', stale: true });
    const r = await pool.query('UPDATE users SET terms_accepted_at = NOW(), terms_version = $1 WHERE id = $2 AND terms_version IS DISTINCT FROM $1 RETURNING id', [TERMS_VERSION, req.user.id]);
    if (r.rows.length) await pool.query('INSERT INTO terms_acceptances (user_id, version) VALUES ($1, $2)', [req.user.id, TERMS_VERSION]);
    res.json({ terms_current: true, version: TERMS_VERSION });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Agree to the house rule (jobs that start on DirtBidder are hired and paid on DirtBidder). Kept with the date.
app.post('/api/me/rules', authMiddleware, async (req, res) => {
  try {
    if (req.body.agree !== true) return res.status(400).json({ error: 'Tap “I understand” to continue.' });
    await pool.query('UPDATE users SET rules_ack_at = NOW() WHERE id = $1 AND rules_ack_at IS NULL', [req.user.id]);
    res.json({ rules_ack: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update your own name, phone and company name (Settings page)
app.put('/api/me', authMiddleware, async (req, res) => {
  try {
    const clean = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : null;
    const name = clean(req.body.name, 255), phone = clean(req.body.phone, 50), company = clean(req.body.company_name, 255);
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const r = await pool.query(
      'UPDATE users SET name = $1, phone = $2, company_name = $3 WHERE id = $4 RETURNING id, email, role, name, phone, company_name',
      [name, phone || null, company || null, req.user.id]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Operator profile details (equipment, service area, experience, short bio). Only known keys are kept.
app.put('/api/me/profile', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : undefined;
    const patch = {};
    if (Array.isArray(b.equipment)) patch.equipment = b.equipment.filter(x => typeof x === 'string').map(x => x.trim().slice(0, 60)).filter(Boolean).slice(0, 30);
    for (const [k, n] of [['equipmentOther', 300], ['zip', 10], ['serviceRadius', 30], ['yearsExp', 30], ['bio', 800]]) {
      const v = str(b[k], n); if (v !== undefined) patch[k] = v;
    }
    if (typeof b.jobAlerts === 'boolean') patch.jobAlerts = b.jobAlerts; // new-job emails on/off
    // Shoutouts: OK to feature the company on DirtBidder's social media after a 4 or 5 star job. The date they said yes is kept.
    if (typeof b.featureOk === 'boolean') {
      if (b.featureOk && req.user.role !== 'operator') return res.status(400).json({ error: 'Shoutouts are for operator accounts.' });
      patch.featureOk = b.featureOk;
      patch.featureOkAt = b.featureOk ? new Date().toISOString() : null;
    }
    const { scanFields, addFlag } = require('./lib/flags');
    const scan = scanFields({ bio: patch.bio, equipmentOther: patch.equipmentOther });
    if (patch.bio !== undefined) patch.bio = scan.cleaned.bio;
    if (patch.equipmentOther !== undefined) patch.equipmentOther = scan.cleaned.equipmentOther;
    if (scan.reasons.length) addFlag(pool, { kind: 'profile', userId: req.user.id, reason: 'Profile ' + scan.reasons.join(', '), details: scan.original });
    const r = await pool.query(
      "UPDATE users SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb WHERE id = $2 RETURNING profile",
      [JSON.stringify(patch), req.user.id]);
    if (patch.featureOk === true) require('./lib/shoutouts').onOptIn(pool, req.user.id); // good reviews already waiting become ready to post
    res.json(r.rows[0].profile);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change password while logged in (needs the current one)
app.post('/api/me/password', authMiddleware, async (req, res) => {
  try {
    const current = String(req.body.current_password || ''), next = String(req.body.new_password || '');
    if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const u = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!u.rows[0] || !(await bcrypt.compare(current, u.rows[0].password_hash))) return res.status(400).json({ error: 'Current password is wrong' });
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(next, 10), req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

const jobsRoutes = require('./routes/jobs');
const bidsRoutes = require('./routes/bids');
const dashboardRoutes = require('./routes/dashboard');

// ── Email confirmation ──
// New accounts get a "confirm your email" link. The account works without it; the dashboards nag until it's done,
// and the admin Users tab shows who has confirmed. While unconfirmed, the user can correct a mistyped address.
const confirmPage = (res, title, text) => res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DirtBidder</title></head>
<body style="margin:0;background:#1C1410;color:#F2EDE6;font-family:Arial,Helvetica,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="max-width:420px;padding:32px 24px;text-align:center"><div style="font-size:26px;font-weight:900;margin-bottom:18px"><span style="color:#E8892A">Dirt</span>Bidder</div>
<h1 style="font-size:20px;margin:0 0 12px">${title}</h1><p style="color:#C4A882;line-height:1.5;margin:0 0 22px">${text}</p>
<a href="${process.env.FRONTEND_URL || 'https://www.dirtbidder.com'}/dirtbidder-login.html" style="display:inline-block;background:#E8892A;color:#1C1410;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:4px">Go to DirtBidder</a></div></body></html>`);

app.get('/api/confirm-email', async (req, res) => {
  try {
    const d = jwt.verify(String(req.query.t || ''), JWT_SECRET);
    if (d.confirm !== 1) throw new Error('wrong link');
    // The link only counts for the address it was sent to (a corrected address needs its own link)
    const r = await pool.query(
      'UPDATE users SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()) WHERE id = $1 AND lower(email) = $2 RETURNING id', [d.id, String(d.email || '').toLowerCase()]);
    if (!r.rows[0]) throw new Error('address changed');
    confirmPage(res, 'Your email is confirmed ✓', 'Thanks. Job alerts, bids and payment notices will come to this address.');
  } catch (err) {
    res.status(400);
    confirmPage(res, 'That link didn’t work', 'It may be old, or the email on the account was changed. Log in and tap “Resend link” to get a new one.');
  }
});

const lastConfirmSend = new Map(); // userId -> time, so the resend button can't be hammered
const confirmThrottled = id => { const t = lastConfirmSend.get(id) || 0; if (Date.now() - t < 60000) return true; lastConfirmSend.set(id, Date.now()); return false; };

app.post('/api/me/confirm-email', authMiddleware, async (req, res) => {
  try {
    const u = (await pool.query('SELECT email, email_confirmed_at FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.email_confirmed_at) return res.json({ confirmed: true });
    if (confirmThrottled(req.user.id)) return res.status(429).json({ error: 'We just sent one. Give it a minute, and check your spam folder.' });
    notify.confirmEmail(pool, req.user.id);
    res.json({ sent: true, email: u.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fix a mistyped address. Only while the email is still unconfirmed; after that, changes go through support.
app.put('/api/me/email', authMiddleware, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 255) return res.status(400).json({ error: 'That email address doesn’t look right.' });
    const u = (await pool.query('SELECT email, email_confirmed_at FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.email_confirmed_at) return res.status(400).json({ error: 'Your email is already confirmed. To change it, reply to any DirtBidder email and we’ll help.' });
    const taken = await pool.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [email, req.user.id]);
    if (taken.rows.length) return res.status(400).json({ error: 'Another account already uses that email.' });
    await pool.query('UPDATE users SET email = $1 WHERE id = $2 AND email_confirmed_at IS NULL', [email, req.user.id]);
    lastConfirmSend.set(req.user.id, Date.now());
    notify.confirmEmail(pool, req.user.id);
    res.json({ email, sent: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Turn off new-job emails from the link in the email (no login needed; the link is signed)
const alertsOff = async (req, res) => {
  const page = (title, text) => res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DirtBidder</title></head>
<body style="margin:0;background:#1C1410;color:#F2EDE6;font-family:Arial,Helvetica,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="max-width:420px;padding:32px 24px;text-align:center"><div style="font-size:26px;font-weight:900;margin-bottom:18px"><span style="color:#E8892A">Dirt</span>Bidder</div>
<h1 style="font-size:20px;margin:0 0 12px">${title}</h1><p style="color:#C4A882;line-height:1.5;margin:0 0 22px">${text}</p>
<a href="${process.env.FRONTEND_URL || 'https://www.dirtbidder.com'}/dirtbidder-operator-dashboard.html" style="display:inline-block;background:#E8892A;color:#1C1410;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:4px">Open Dashboard</a></div></body></html>`);
  try {
    const d = jwt.verify(String(req.query.t || ''), JWT_SECRET);
    if (d.alerts !== 'off') throw new Error('wrong link');
    await pool.query("UPDATE users SET profile = COALESCE(profile, '{}'::jsonb) || '{\"jobAlerts\": false}'::jsonb, email_confirmed_at = COALESCE(email_confirmed_at, NOW()) WHERE id = $1", [d.id]);
    page('New-job emails are off', 'You won’t get an email when jobs are posted. You’ll still get emails about your own bids, jobs and payments. You can turn these back on any time in Settings.');
  } catch (err) {
    res.status(400);
    page('That link didn’t work', 'Log in and open Settings to turn new-job emails on or off.');
  }
};
app.get('/api/alerts/unsubscribe', alertsOff);
app.post('/api/alerts/unsubscribe', alertsOff);

app.use('/api/jobs', jobsRoutes(pool, authMiddleware));
app.use('/api/bids', bidsRoutes(pool, authMiddleware));
app.use('/api/dashboard', dashboardRoutes(pool, authMiddleware, ownerOnly));
app.use('/api/payments', require('./routes/payments')(pool, authMiddleware));
app.use('/api/connect', require('./routes/connect')(pool, authMiddleware));
app.use('/api/password', require('./routes/password')(pool));
app.use('/api/reviews', require('./routes/reviews')(pool, authMiddleware));
app.use('/api/reports', require('./routes/reports')(pool, authMiddleware));
// Public page-view counter for the owner's HQ (no login; stores no IPs)
app.post('/api/track', (req, res) => {
  require('./lib/hq').track(pool, req).catch(err => console.error('Track error:', err.message));
  res.status(204).end();
});
app.use('/api/admin', require('./routes/admin')(pool, authMiddleware, adminOnly, ADMIN_EMAILS));
app.use('/api/changes', require('./routes/changes')(pool, authMiddleware, ADMIN_EMAILS));
app.use('/api/messages', require('./routes/messages')(pool, authMiddleware, ADMIN_EMAILS));
app.use('/api/disputes', require('./routes/disputes')(pool, authMiddleware, adminOnly));

// Public photo URL (unguessable token) so <img> tags can load it without a login header
app.get('/api/photos/:token', async (req, res) => {
  try {
    const r = await pool.query('SELECT mime, data FROM job_photos WHERE token = $1', [req.params.token]);
    if (r.rows.length === 0) return res.status(404).send('Not found');
    res.set('Content-Type', r.rows[0].mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(r.rows[0].data);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Owner dashboard data
app.get('/api/admin/summary', authMiddleware, ownerOnly, async (req, res) => {
  try {
    const payments = await pool.query('SELECT SUM(amount) as total_revenue, SUM(platform_fee) as total_fees FROM payments WHERE status = $1', ['completed']);
    const jobCount = await pool.query('SELECT COUNT(*) FROM jobs');
    const userCount = await pool.query('SELECT COUNT(*) FROM users');
    res.json({
      total_revenue: payments.rows[0].total_revenue || 0,
      total_fees: payments.rows[0].total_fees || 0,
      job_count: jobCount.rows[0].count,
      user_count: userCount.rows[0].count
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/', (req, res) => res.send('DirtBidder backend is running'));
async function runMigrations() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS escrow_transactions (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        amount DECIMAL(12,2) NOT NULL,
        status VARCHAR(50) DEFAULT 'held',
        stripe_payment_intent_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        reviewer_id INTEGER NOT NULL REFERENCES users(id),
        reviewee_id INTEGER NOT NULL REFERENCES users(id),
        rating INTEGER CHECK (rating >= 1 AND rating <= 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Bring older jobs/bids tables up to date with the current code (safe to re-run)
    const upgrades = [
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES users(id)",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description TEXT",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS location VARCHAR(255)",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_type VARCHAR(100)",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS acreage VARCHAR(100)",
      "ALTER TABLE jobs ALTER COLUMN acreage TYPE VARCHAR(100) USING acreage::text",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS timeline VARCHAR(100)",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'open'",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS budget DECIMAL(12,2)",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()",
      "ALTER TABLE bids ADD COLUMN IF NOT EXISTS operator_id INTEGER REFERENCES users(id)",
      "ALTER TABLE bids ADD COLUMN IF NOT EXISTS amount DECIMAL(12,2)",
      "ALTER TABLE bids ADD COLUMN IF NOT EXISTS message TEXT",
      "ALTER TABLE bids ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending'",
      "ALTER TABLE bids ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name VARCHAR(255)",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS profile JSONB",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hired_at TIMESTAMP",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS site_address TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT",
      `CREATE TABLE IF NOT EXISTS flags (
         id SERIAL PRIMARY KEY,
         kind VARCHAR(20) NOT NULL,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         reporter_id INTEGER REFERENCES users(id),
         job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
         bid_id INTEGER REFERENCES bids(id) ON DELETE SET NULL,
         reason TEXT NOT NULL,
         details TEXT,
         status VARCHAR(20) DEFAULT 'open',
         reviewed_at TIMESTAMP,
         created_at TIMESTAMP DEFAULT NOW()
       )`,
      `CREATE TABLE IF NOT EXISTS user_warnings (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         reason TEXT NOT NULL,
         created_by INTEGER REFERENCES users(id),
         created_at TIMESTAMP DEFAULT NOW()
       )`,
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version VARCHAR(20)",
      "CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_per_job ON reviews(job_id, reviewer_id)",
      `CREATE TABLE IF NOT EXISTS job_photos (
         id SERIAL PRIMARY KEY,
         job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
         token VARCHAR(64) UNIQUE NOT NULL,
         mime VARCHAR(50) NOT NULL,
         data BYTEA NOT NULL,
         created_at TIMESTAMP DEFAULT NOW()
       )`,
      "CREATE INDEX IF NOT EXISTS job_photos_job_id ON job_photos(job_id)",
      `CREATE TABLE IF NOT EXISTS disputes (
         id SERIAL PRIMARY KEY,
         job_id INTEGER NOT NULL REFERENCES jobs(id),
         escrow_id INTEGER REFERENCES escrow_transactions(id),
         opened_by INTEGER REFERENCES users(id),
         reason TEXT NOT NULL,
         previous_job_status VARCHAR(50),
         status VARCHAR(20) DEFAULT 'open',
         operator_response TEXT,
         operator_responded_at TIMESTAMP,
         resolution VARCHAR(20),
         refund_amount DECIMAL(12,2),
         operator_amount DECIMAL(12,2),
         admin_note TEXT,
         resolved_by INTEGER REFERENCES users(id),
         resolved_at TIMESTAMP,
         created_at TIMESTAMP DEFAULT NOW()
       )`,
      "ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS kind VARCHAR(20) DEFAULT 'site'",
      "ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS dispute_id INTEGER REFERENCES disputes(id)",
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS stripe_refund_id VARCHAR(255)",
      `CREATE TABLE IF NOT EXISTS password_resets (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         token_hash VARCHAR(64) UNIQUE NOT NULL,
         expires_at TIMESTAMP NOT NULL,
         used_at TIMESTAMP,
         created_at TIMESTAMP DEFAULT NOW()
       )`,
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS bid_id INTEGER REFERENCES bids(id)",
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS client_fee DECIMAL(12,2)",
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS operator_fee DECIMAL(12,2)",
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS client_total DECIMAL(12,2)",
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS operator_payout DECIMAL(12,2)",
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(255)",
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS released_at TIMESTAMP",
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS stripe_transfer_id VARCHAR(255)",
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS paid_out_at TIMESTAMP",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_account_id VARCHAR(255)",
      "ALTER TABLE bids ADD COLUMN IF NOT EXISTS est_days INTEGER",
      "ALTER TABLE bids ADD COLUMN IF NOT EXISTS equipment TEXT",
      `CREATE TABLE IF NOT EXISTS messages (
         id SERIAL PRIMARY KEY,
         job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
         operator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         body TEXT NOT NULL,
         original_body TEXT,
         read_at TIMESTAMP,
         created_at TIMESTAMP DEFAULT NOW()
       )`,
      "CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (job_id, operator_id, id)",
      // Bids can be updated until accepted; clients can share the job location with one operator before hiring
      "ALTER TABLE bids ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP",
      "ALTER TABLE bids ADD COLUMN IF NOT EXISTS prev_amount NUMERIC(12,2)",
      `CREATE TABLE IF NOT EXISTS job_location_shares (
         job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
         operator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         created_at TIMESTAMP DEFAULT NOW(),
         PRIMARY KEY (job_id, operator_id)
       )`,
      // Two Stripe modes side by side: remember which mode each payment / payout account belongs to.
      // Everything created before this change was made with the test key.
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS test_mode BOOLEAN",
      "UPDATE escrow_transactions SET test_mode = true WHERE test_mode IS NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_account_test BOOLEAN",
      "UPDATE users SET stripe_account_test = true WHERE stripe_account_id IS NOT NULL AND stripe_account_test IS NULL",
      // Change orders: extra money on a job, requested by the operator and approved/paid by the client
      `CREATE TABLE IF NOT EXISTS change_orders (
         id SERIAL PRIMARY KEY,
         job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
         operator_id INTEGER NOT NULL REFERENCES users(id),
         amount DECIMAL(12,2) NOT NULL,
         reason TEXT NOT NULL,
         client_fee DECIMAL(12,2),
         operator_fee DECIMAL(12,2),
         client_total DECIMAL(12,2),
         operator_payout DECIMAL(12,2),
         status VARCHAR(20) NOT NULL DEFAULT 'pending',
         client_note TEXT,
         decided_at TIMESTAMP,
         paid_at TIMESTAMP,
         created_at TIMESTAMP DEFAULT NOW()
       )`,
      "CREATE INDEX IF NOT EXISTS change_orders_job_idx ON change_orders (job_id)",
      // Shoutouts: did the client say the job was on time, and has the owner posted (or skipped) the shoutout for this review
      "ALTER TABLE reviews ADD COLUMN IF NOT EXISTS on_time BOOLEAN",
      "ALTER TABLE reviews ADD COLUMN IF NOT EXISTS shoutout_status VARCHAR(20)",
      "ALTER TABLE reviews ADD COLUMN IF NOT EXISTS shoutout_at TIMESTAMP",
      "ALTER TABLE reviews ADD COLUMN IF NOT EXISTS shoutout_text TEXT",
      "ALTER TABLE reviews ADD COLUMN IF NOT EXISTS shoutout_notified_at TIMESTAMP",
      "ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS change_order_id INTEGER REFERENCES change_orders(id)",
      "ALTER TABLE job_photos ADD COLUMN IF NOT EXISTS change_order_id INTEGER REFERENCES change_orders(id)",
      // Optional GPS pin for the job site (private, like the exact address)
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS site_lat NUMERIC(9,6)",
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS site_lng NUMERIC(9,6)",
      // Owner's own real-money test jobs: hidden from stats, job lists and operator job counts (Stripe keeps the real record)
      "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS internal BOOLEAN DEFAULT false",
      `UPDATE jobs j SET internal = true FROM users c
       WHERE c.id = j.client_id AND lower(c.email) = 'daniel@dirtbidder.com'
         AND j.title ILIKE 'dirtbidder test%' AND j.status = 'completed' AND NOT COALESCE(j.internal, false)`,
      // One-time cleanup: test-account jobs left "in progress" from before payments existed (never funded)
      `UPDATE jobs j SET status = 'closed' FROM users c
       WHERE c.id = j.client_id AND c.email ~* '\\+(test|op)[0-9]*@' AND j.status = 'in_progress'
         AND j.title ILIKE 'I need a pond excavated%'
         AND NOT EXISTS (SELECT 1 FROM escrow_transactions e WHERE e.job_id = j.id AND e.status NOT IN ('pending_payment', 'cancelled'))`
    ];
    for (const sql of upgrades) {
      try { await pool.query(sql); } catch (e) { console.error('Upgrade step failed:', sql, '-', e.message); }
    }
    // Email confirmation: the owner's own admin address counts as confirmed
    try {
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMP');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS rules_ack_at TIMESTAMP'); // when they agreed to the house rule
      // A dated record of every time someone agreed to the Terms, and which version (sign-up, and again after each update)
      await pool.query(`CREATE TABLE IF NOT EXISTS terms_acceptances (
        id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        version VARCHAR(20) NOT NULL, accepted_at TIMESTAMP NOT NULL DEFAULT NOW())`);
      await pool.query(`INSERT INTO terms_acceptances (user_id, version, accepted_at)
        SELECT u.id, u.terms_version, u.terms_accepted_at FROM users u
        WHERE u.terms_accepted_at IS NOT NULL AND u.terms_version IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM terms_acceptances t WHERE t.user_id = u.id AND t.version = u.terms_version)`);
      await pool.query('UPDATE users SET email_confirmed_at = NOW() WHERE email_confirmed_at IS NULL AND lower(email) = ANY($1::text[])', [ADMIN_EMAILS]);
    } catch (e) { console.error('Email-confirmation setup failed:', e.message); }
    // Sign-up used to allow a blank name (saved as a single space). Store those as empty so "Operator"/"Client" fallbacks show instead of nothing.
    try { await pool.query("UPDATE users SET name = '' WHERE name IS NOT NULL AND name <> '' AND btrim(name) = ''"); } catch (e) { console.error('Blank-name cleanup failed:', e.message); }
    // The owner's own accounts are left out of the HQ numbers, like test accounts (they still work normally on the site).
    // Auto-flagged: admin emails, any "+alias" of an admin email, and the plain address behind a +test / +op account.
    // Also the owner's other personal accounts (OWNER_EMAILS in Railway, comma-separated; defaults below).
    // Anything this misses can be switched by hand on the admin Users tab (users.internal).
    try {
      const OWNER_EMAILS = String(process.env.OWNER_EMAILS || 'dmaxwheeler79@gmail.com,wheeler.dan.m@outlook.com')
        .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS internal BOOLEAN');
      const base = c => `lower(split_part(split_part(${c}, '@', 1), '+', 1) || '@' || split_part(${c}, '@', 2))`;
      const own = await pool.query(
        `UPDATE users u SET internal = true
         WHERE u.internal IS NULL AND u.email !~* '\\+(test|op)[0-9]*@'
           AND (${base('u.email')} = ANY($1::text[])
             OR EXISTS (SELECT 1 FROM users t WHERE t.email ~* '\\+(test|op)[0-9]*@' AND ${base('t.email')} = lower(u.email)))
         RETURNING id, email`, [[...ADMIN_EMAILS, ...OWNER_EMAILS]]);
      if (own.rowCount) console.log('Owner accounts left out of HQ:', own.rows.map(r => r.id + ' ' + r.email).join(', '));
    } catch (e) { console.error('Owner-account flag failed:', e.message); }
    // One-time (Oct 7 2026): a fake client "Test Test" signed up with a throwaway address and a made-up phone.
    // Suspended at the owner's request so it can't post a junk job (a new job emails every operator).
    // No suspension email is sent, since the address is fake. It skips an account that is already suspended.
    // If this account is ever restored by hand on the admin Users tab, delete this block first or the next deploy suspends it again.
    try {
      const gone = await pool.query(
        `UPDATE users SET suspended_at = NOW(), suspended_reason = 'Fake sign-up: placeholder name, made-up phone, throwaway email'
         WHERE lower(email) = 'xicaye4076@calirona.com' AND suspended_at IS NULL AND suspended_reason IS NULL AND role = 'client' RETURNING id`);
      if (gone.rowCount) {
        const closed = await pool.query("UPDATE jobs SET status = 'closed' WHERE client_id = $1 AND status IN ('open', 'test') RETURNING id", [gone.rows[0].id]);
        console.log('Suspended fake sign-up: user', gone.rows[0].id, '· jobs closed:', closed.rowCount);
      }
    } catch (e) { console.error('Fake sign-up suspend failed:', e.message); }
    // Jobs posted by test accounts (+test / +op emails) must never be public
    const hiddenTests = await pool.query(
      "UPDATE jobs SET status = 'test' WHERE status = 'open' AND client_id IN (SELECT id FROM users WHERE email ~* '\\+(test|op)[0-9]*@') RETURNING id");
    if (hiddenTests.rowCount) console.log('Hid test-account jobs:', hiddenTests.rows.map(r => r.id).join(','));
    // One-time fix (Sep 29 2026): admin account daniel@dirtbidder.com was created under the name "John Timms".
    // Rename it, and hide any job it posted while testing so operators don't see it as real.
    const fixed = await pool.query(
      "UPDATE users SET name = 'Daniel Wheeler' WHERE lower(email) = 'daniel@dirtbidder.com' AND name ILIKE 'john timms' RETURNING id"
    );
    if (fixed.rows[0]) {
      const hid = await pool.query(
        "UPDATE jobs SET status = 'test' WHERE client_id = $1 AND status = 'open' AND created_at < '2026-09-30' RETURNING id",
        [fixed.rows[0].id]
      );
      console.log('Renamed admin account; hid test jobs:', hid.rowCount);
    }

    // Hide any jobs posted by test accounts from operators
    const hidden = await pool.query(
      "UPDATE jobs SET status = 'test' WHERE status = 'open' AND client_id IN (SELECT id FROM users WHERE email ILIKE '%+test%')"
    );
    console.log('Test jobs hidden:', hidden.rowCount);
    const cols = await pool.query(
      "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name IN ('jobs','bids') ORDER BY table_name, ordinal_position"
    );
    console.log('Schema check:', cols.rows.map(r => `${r.table_name}.${r.column_name}:${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ''}`).join(', '));
    console.log('Migrations complete');
  } catch (err) {
    console.error('Migration error:', err);
  }
}
runMigrations().then(() => require('./lib/hq').migrate(pool))
  .then(() => require('./lib/confirmReminders').migrate(pool).catch(err => console.error('Confirm reminder setup failed:', err.message))).then(() => {
  // Every 15 minutes: pay out jobs the client didn't release or dispute within 72 hours,
  // check bank payments that are still clearing, send the owner's morning report once a day (from 7am Central),
  // and remind people who signed up but never confirmed their email (2 days and 6 days after sign-up, daytime only)
  const { autoReleaseDueJobs } = require('./lib/release');
  const hq = require('./lib/hq');
  const tick = () => {
    autoReleaseDueJobs(pool).catch(err => console.error('Auto-release error:', err.message));
    hq.reportTick(pool).catch(err => console.error('Daily report error:', err.message));
    require('./lib/funding').checkProcessing(pool).catch(err => console.error('Bank payment check error:', err.message));
    require('./lib/confirmReminders').run(pool).catch(err => console.error('Confirm reminder error:', err.message));
  };
  tick();
  setInterval(tick, 15 * 60 * 1000);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
