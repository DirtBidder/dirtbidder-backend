const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' })); // room for one resized job photo per request

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';

// Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { email, password, name, phone, role, profile } = req.body;
    const companyName = profile && typeof profile.companyName === 'string' ? profile.companyName.trim().slice(0, 255) : null;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, role, name, phone, company_name, profile) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, email, role, name',
      [email, hash, role === 'operator' ? 'operator' : 'client', name, phone, companyName || null, profile ? JSON.stringify(profile) : null]
    );

    const user = result.rows[0];
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
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Auth middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
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
    const result = await pool.query('SELECT id, email, role, name, phone, company_name FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    result.rows[0].is_admin = result.rows[0].role === 'owner' || ADMIN_EMAILS.includes(String(result.rows[0].email || '').toLowerCase());
    res.json(result.rows[0]);
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

app.use('/api/jobs', jobsRoutes(pool, authMiddleware));
app.use('/api/bids', bidsRoutes(pool, authMiddleware));
app.use('/api/dashboard', dashboardRoutes(pool, authMiddleware, ownerOnly));
app.use('/api/payments', require('./routes/payments')(pool, authMiddleware));
app.use('/api/connect', require('./routes/connect')(pool, authMiddleware));
app.use('/api/password', require('./routes/password')(pool));
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
      "ALTER TABLE bids ADD COLUMN IF NOT EXISTS equipment TEXT"
    ];
    for (const sql of upgrades) {
      try { await pool.query(sql); } catch (e) { console.error('Upgrade step failed:', sql, '-', e.message); }
    }
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
runMigrations().then(() => {
  // Every 15 minutes: pay out jobs the client didn't release or dispute within 72 hours
  const { autoReleaseDueJobs } = require('./lib/release');
  const tick = () => autoReleaseDueJobs(pool).catch(err => console.error('Auto-release error:', err.message));
  tick();
  setInterval(tick, 15 * 60 * 1000);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
