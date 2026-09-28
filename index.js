const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';

// Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { email, password, name, phone, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, role, name, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role, name',
      [email, hash, role || 'client', name, phone]
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

// Owner-only middleware
function ownerOnly(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access only' });
  next();
}
// Current logged-in user
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, role, name FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
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
      "ALTER TABLE bids ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()"
    ];
    for (const sql of upgrades) {
      try { await pool.query(sql); } catch (e) { console.error('Upgrade step failed:', sql, '-', e.message); }
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
runMigrations();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
