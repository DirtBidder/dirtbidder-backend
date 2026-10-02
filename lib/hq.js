// HQ extras: visitor counting, the owner's to-do list, and the 7am daily report email.
const crypto = require('crypto');
const { sendEmail, SITE } = require('./email');

const TZ = 'America/Chicago';
const SECRET = process.env.JWT_SECRET || 'dirtbidder';
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|monitor|curl|wget|python|axios/i;
const TEST_EMAIL = `'\\+(test|op)[0-9]*@'`;
// A timestamp column as a Central-time calendar date
const localDay = col => `((${col} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date`;

const SEED_TASKS = [
  'Call IRS for 147C letter (800-829-4933, 7am)',
  'Upload EIN letter to Stripe and switch to live payments',
  'Get a lawyer to review Terms & Privacy',
  'Set up Stripe Tax (waiting on Iowa Dept. of Revenue)',
  'Upgrade Vercel to Pro before launch',
  'Follow up with Rasch, PCI and Reilly',
  'Sign up the first founding operators',
  'Save Polsia logo + jobsite photo, then cancel Polsia',
  'Set up Anthropic API account (turns on Ask Claude)'
];

async function migrate(pool) {
  const steps = [
    `CREATE TABLE IF NOT EXISTS page_views (
       id SERIAL PRIMARY KEY,
       day DATE NOT NULL,
       path VARCHAR(200),
       visitor VARCHAR(64) NOT NULL,
       referrer VARCHAR(300),
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    'CREATE INDEX IF NOT EXISTS page_views_day_idx ON page_views (day)',
    `CREATE TABLE IF NOT EXISTS hq_tasks (
       id SERIAL PRIMARY KEY,
       title VARCHAR(300) NOT NULL,
       done_at TIMESTAMP,
       sort INTEGER DEFAULT 0,
       created_at TIMESTAMP DEFAULT NOW()
     )`,
    'CREATE TABLE IF NOT EXISTS hq_settings (key VARCHAR(50) PRIMARY KEY, value TEXT)',
    'CREATE TABLE IF NOT EXISTS hq_reports (day DATE PRIMARY KEY, sent_at TIMESTAMP DEFAULT NOW())',
    `CREATE TABLE IF NOT EXISTS payment_waitlist (
       id SERIAL PRIMARY KEY,
       bid_id INTEGER UNIQUE,
       user_id INTEGER,
       job_id INTEGER,
       notified_at TIMESTAMP,
       created_at TIMESTAMP DEFAULT NOW()
     )`
  ];
  for (const sql of steps) {
    try { await pool.query(sql); } catch (e) { console.error('HQ migrate step failed:', e.message); }
  }
  // Starter to-do list, added once (deleting them later won't bring them back)
  try {
    const seeded = await pool.query("INSERT INTO hq_settings (key, value) VALUES ('tasks_seeded', '1') ON CONFLICT DO NOTHING RETURNING key");
    if (seeded.rows.length) {
      for (let i = 0; i < SEED_TASKS.length; i++) await pool.query('INSERT INTO hq_tasks (title, sort) VALUES ($1, $2)', [SEED_TASKS[i], i]);
      console.log('HQ: starter to-do list added');
    }
  } catch (e) { console.error('HQ seed failed:', e.message); }
}

// Public page view. Stores a daily one-way hash of IP + browser — never the IP itself.
async function track(pool, req) {
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT.test(ua)) return;
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const day = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD in Central time
  const visitor = crypto.createHash('sha256').update(`${SECRET}|${day}|${ip}|${ua}`).digest('hex').slice(0, 32);
  const path = String((req.body && req.body.path) || '').slice(0, 200) || '/';
  let ref = String((req.body && req.body.ref) || '');
  try { ref = ref ? new URL(ref).hostname : ''; } catch (e) { ref = ''; }
  if (/dirtbidder\.com$|vercel\.app$/i.test(ref)) ref = ''; // clicks inside our own site aren't referrals
  await pool.query('INSERT INTO page_views (day, path, visitor, referrer) VALUES ($1, $2, $3, $4)', [day, path, visitor, ref.slice(0, 300) || null]);
}

async function visitorStats(pool) {
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(DISTINCT visitor) FROM page_views WHERE day = (NOW() AT TIME ZONE '${TZ}')::date)::int AS today,
       (SELECT COUNT(DISTINCT visitor || day::text) FROM page_views WHERE day > (NOW() AT TIME ZONE '${TZ}')::date - 7)::int AS last_7d,
       (SELECT COUNT(*) FROM page_views WHERE day > (NOW() AT TIME ZONE '${TZ}')::date - 7)::int AS views_7d,
       (SELECT COALESCE(json_agg(t), '[]') FROM (
          SELECT referrer AS site, COUNT(DISTINCT visitor)::int AS n FROM page_views
          WHERE referrer IS NOT NULL AND day > (NOW() AT TIME ZONE '${TZ}')::date - 30
          GROUP BY referrer ORDER BY n DESC LIMIT 5) t) AS top_referrers`);
  const weekly = await pool.query(
    `SELECT to_char(date_trunc('week', day::timestamp), 'YYYY-MM-DD') AS week, COUNT(DISTINCT visitor || day::text)::int AS visitors
     FROM page_views WHERE day > (NOW() AT TIME ZONE '${TZ}')::date - 56 GROUP BY 1`);
  return { ...r.rows[0], weekly: Object.fromEntries(weekly.rows.map(w => [w.week, w.visitors])) };
}

// Numbers for one Central-time day (real accounts only)
async function dayNumbers(pool, day) {
  const real = a => `NOT ${a}.email ~* ${TEST_EMAIL}`;
  const realJob = (j, c) => `${j}.status <> 'test' AND NOT COALESCE(${j}.internal, false) AND ${real(c)}`;
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM users u WHERE ${localDay('u.created_at')} = $1 AND ${real('u')} AND u.role = 'client')::int AS new_clients,
       (SELECT COUNT(*) FROM users u WHERE ${localDay('u.created_at')} = $1 AND ${real('u')} AND u.role = 'operator')::int AS new_operators,
       (SELECT COUNT(*) FROM jobs j JOIN users c ON c.id = j.client_id WHERE ${localDay('j.created_at')} = $1 AND ${realJob('j', 'c')})::int AS jobs,
       (SELECT COUNT(*) FROM bids b JOIN jobs j ON j.id = b.job_id JOIN users c ON c.id = j.client_id JOIN users o ON o.id = b.operator_id
          WHERE ${localDay('b.created_at')} = $1 AND ${realJob('j', 'c')} AND ${real('o')})::int AS bids,
       (SELECT COALESCE(SUM(e.amount), 0) FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id JOIN users c ON c.id = j.client_id
          WHERE ${localDay('e.created_at')} = $1 AND e.status NOT IN ('pending_payment', 'cancelled', 'processing', 'failed') AND ${realJob('j', 'c')})::float AS paid_in,
       (SELECT COALESCE(SUM(COALESCE(e.client_fee, 0) + COALESCE(e.operator_fee, 0)), 0) FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id JOIN users c ON c.id = j.client_id
          WHERE e.status = 'released' AND ${localDay('e.released_at')} = $1 AND ${realJob('j', 'c')})::float AS fees,
       (SELECT COUNT(DISTINCT visitor) FROM page_views WHERE day = $1)::int AS visitors,
       (SELECT COALESCE(SUM(e.amount), 0) FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id JOIN users c ON c.id = j.client_id
          WHERE e.status IN ('held', 'disputed') AND ${realJob('j', 'c')})::float AS in_escrow,
       (SELECT COUNT(*) FROM disputes WHERE status = 'open')::int AS disputes,
       (SELECT COUNT(*) FROM flags WHERE status = 'open')::int AS flags,
       (SELECT COUNT(*) FROM hq_tasks WHERE done_at IS NULL)::int AS open_tasks,
       (SELECT title FROM hq_tasks WHERE done_at IS NULL ORDER BY sort, id LIMIT 1) AS next_task`, [day]);
  return r.rows[0];
}

const money = n => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

async function sendDailyReport(pool, { force = false } = {}) {
  const now = new Date();
  const today = now.toLocaleDateString('en-CA', { timeZone: TZ });
  const y = new Date(now.getTime() - 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: TZ });
  if (!force) {
    const claimed = await pool.query('INSERT INTO hq_reports (day) VALUES ($1) ON CONFLICT DO NOTHING RETURNING day', [today]);
    if (!claimed.rows.length) return false; // already sent today
  }
  const d = await dayNumbers(pool, y);
  const label = new Date(y + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const needs = [];
  if (d.disputes) needs.push(plural(d.disputes, 'open dispute'));
  if (d.flags) needs.push(plural(d.flags, 'flag'));
  const lines = [
    `Yesterday (${label}):`,
    `• ${plural(d.visitors, 'visitor')} to dirtbidder.com`,
    `• ${plural(d.new_clients, 'new client')}, ${plural(d.new_operators, 'new operator')}`,
    `• ${plural(d.jobs, 'job')} posted, ${plural(d.bids, 'bid')} placed`,
    `• ${money(d.paid_in)} paid into escrow · ${money(d.fees)} in fees earned`,
    `Right now: ${money(d.in_escrow)} held in escrow.`,
    needs.length ? `Needs you: ${needs.join(' and ')}.` : 'Nothing needs you — no open disputes or flags.',
    d.open_tasks ? `To-do: ${plural(d.open_tasks, 'item')} left${d.next_task ? ` — next up: ${d.next_task}` : ''}.` : 'To-do list is clear.'
  ];
  const { ADMIN_EMAILS } = module.exports;
  for (const to of ADMIN_EMAILS) {
    await sendEmail(to, {
      subject: `DirtBidder daily: ${plural(d.visitors, 'visitor')}, ${plural(d.jobs, 'job')}, ${plural(d.bids, 'bid')}${needs.length ? ' · needs you' : ''}`,
      heading: 'Your DirtBidder morning report',
      lines,
      button: { label: 'Open HQ', url: SITE + '/dirtbidder-hq.html' }
    });
  }
  console.log('HQ: daily report sent for', y);
  return true;
}

// Called every 15 minutes: sends the report once, any time from 7:00am Central on
async function reportTick(pool) {
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }));
  if (hour >= 7 && hour < 12) await sendDailyReport(pool);
}

module.exports = {
  migrate, track, visitorStats, sendDailyReport, reportTick,
  ADMIN_EMAILS: (process.env.ADMIN_EMAILS || 'daniel@dirtbidder.com').split(',').map(e => e.trim()).filter(Boolean)
};
