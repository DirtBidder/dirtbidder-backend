// Stale job check-ins: keeps the job board fresh without taking down jobs clients still want.
//   30 days after a job is posted with nobody hired (90 days for "planning ahead / just getting prices" jobs),
//   the client gets an email: keep it open (one tap) or close it.
//   If they don't answer within 7 days, the job closes on its own and the operators who bid are told.
//   Tapping "Keep it open" restarts the clock, so they're asked again 30 (or 90) days later.
// Skipped: hired/closed/test jobs, internal jobs, test (+test / +op) and suspended clients, jobs with a payment in progress.
// Sent only 8am-5pm Central. To switch it off without a deploy, set JOB_CHECKINS=off in Railway.
const jwt = require('jsonwebtoken');
const { sendEmail, SITE } = require('./email');

const TZ = 'America/Chicago';
const DAYS = 30, PLANNING_DAYS = 90, GRACE_DAYS = 7;
const TEST = "'\\+(test|op)[0-9]*@'";
const SECRET = () => process.env.JWT_SECRET || 'change_this_secret';
const PLANNING = "j.timeline ~* '(just (planning|getting prices)|planning ahead|not hiring)'";
const START = 'GREATEST(j.created_at, COALESCE(j.kept_open_at, j.created_at))'; // the clock restarts when the client keeps it open
const BASE = `j.status = 'open' AND NOT COALESCE(j.internal, false)
  AND cu.suspended_at IS NULL AND cu.email IS NOT NULL AND cu.email <> '' AND cu.email !~* ${TEST}
  AND NOT EXISTS (SELECT 1 FROM escrow_transactions e WHERE e.job_id = j.id AND e.status IN ('held', 'pending_payment'))`;

async function migrate(pool) {
  await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS checkin_sent_at TIMESTAMP');
  await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kept_open_at TIMESTAMP');
  await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_closed_at TIMESTAMP');
}

const keepUrl = jobId => `${process.env.API_URL || 'https://dirtbidder-backend-production.up.railway.app'}/api/jobs/keep-open?t=` +
  encodeURIComponent(jwt.sign({ job: jobId, kind: 'keep-open' }, SECRET(), { expiresIn: '60d' }));

// Jobs that are due a check-in email
const dueCheckins = () => `
  SELECT j.id, j.title, j.timeline, cu.email AS client_email, cu.name AS client_name,
         (SELECT COUNT(*) FROM bids b WHERE b.job_id = j.id AND b.status = 'pending')::int AS bids
  FROM jobs j JOIN users cu ON cu.id = j.client_id
  WHERE ${BASE}
    AND (j.checkin_sent_at IS NULL OR j.checkin_sent_at < ${START})
    AND ${START} <= NOW() - (CASE WHEN ${PLANNING} THEN INTERVAL '${PLANNING_DAYS} days' ELSE INTERVAL '${DAYS} days' END)
  ORDER BY j.id`;

// Jobs whose check-in went unanswered for the grace period
const dueCloses = () => `
  SELECT j.id, j.title, cu.email AS client_email, cu.name AS client_name
  FROM jobs j JOIN users cu ON cu.id = j.client_id
  WHERE ${BASE}
    AND j.checkin_sent_at IS NOT NULL AND j.checkin_sent_at >= ${START}
    AND j.checkin_sent_at <= NOW() - INTERVAL '${GRACE_DAYS} days'
  ORDER BY j.id`;

function checkinEmail(j) {
  const first = String(j.client_name || '').trim().split(/\s+/)[0];
  const bids = j.bids ? `It has ${j.bids} bid${j.bids === 1 ? '' : 's'} waiting.` : 'It hasn’t gotten a bid yet.';
  return {
    subject: `Still need "${j.title}" done?`,
    heading: 'Is your job still open?',
    lines: [`${first ? 'Hi ' + first + ', ' : ''}your job "${j.title}" has been up for a while with nobody hired. ${bids}`,
      'Still looking? Tap the button and it stays up. That’s all you need to do.',
      `Already decided, or plans changed? You can close it from My Jobs. If we don’t hear from you in ${GRACE_DAYS} days, we’ll close it for you so contractors aren’t left waiting. You can always post it again.`],
    button: { label: 'Keep My Job Open', url: keepUrl(j.id) }
  };
}

function closedEmail(j) {
  const first = String(j.client_name || '').trim().split(/\s+/)[0];
  return {
    subject: `We closed "${j.title}"`,
    heading: 'Your job was closed',
    lines: [`${first ? 'Hi ' + first + ', ' : ''}we didn’t hear back, so "${j.title}" has been taken down and any bids on it were declined.`,
      'If you still need the work done, post it again anytime. “Fill in from my last job” on the Post a Job page copies the details for you.'],
    button: { label: 'Post It Again', url: SITE + '/dirtbidder-post-job.html' }
  };
}

async function run(pool, { now = new Date() } = {}) {
  if (String(process.env.JOB_CHECKINS || '').toLowerCase() === 'off') return { checkins: 0, closed: 0 };
  const hour = Number(now.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;
  if (!(hour >= 8 && hour < 17)) return { checkins: 0, closed: 0 }; // 8am to 5pm Central only
  let checkins = 0, closed = 0;

  for (const j of (await pool.query(dueCheckins())).rows) {
    // Mark first, so two runs at once can never send twice
    const m = await pool.query(`UPDATE jobs j SET checkin_sent_at = NOW() WHERE j.id = $1 AND (j.checkin_sent_at IS NULL OR j.checkin_sent_at < ${START}) RETURNING j.id`, [j.id]);
    if (m.rows.length && await sendEmail(j.client_email, checkinEmail(j))) checkins++;
  }

  for (const j of (await pool.query(dueCloses())).rows) {
    const c = await pool.query("UPDATE jobs SET status = 'closed', auto_closed_at = NOW() WHERE id = $1 AND status = 'open' RETURNING id", [j.id]);
    if (!c.rows.length) continue;
    const declined = await pool.query("UPDATE bids SET status = 'declined' WHERE job_id = $1 AND status = 'pending' RETURNING operator_id", [j.id]);
    // Operators who bid hear it's closed. (Operators shown the site get the usual keep-it-on-DirtBidder reminder.)
    const shown = await pool.query('SELECT operator_id FROM job_location_shares WHERE job_id = $1', [j.id]).catch(() => ({ rows: [] }));
    require('./notify').jobClosed(pool, j.id, declined.rows.map(r => r.operator_id), shown.rows.map(r => r.operator_id));
    await sendEmail(j.client_email, closedEmail(j));
    closed++;
  }
  if (checkins || closed) console.log(`Job check-ins: ${checkins} sent, ${closed} closed`);
  return { checkins, closed };
}

// "Keep My Job Open" link from the check-in email
async function keepOpen(pool, token) {
  const d = jwt.verify(String(token || ''), SECRET());
  if (d.kind !== 'keep-open') throw new Error('wrong link');
  const r = await pool.query("UPDATE jobs SET kept_open_at = NOW() WHERE id = $1 AND status = 'open' RETURNING title", [d.job]);
  if (r.rows.length) return { ok: true, title: r.rows[0].title };
  const s = await pool.query('SELECT title, status FROM jobs WHERE id = $1', [d.job]);
  return { ok: false, title: s.rows[0] && s.rows[0].title, status: s.rows[0] && s.rows[0].status };
}

module.exports = { migrate, run, keepOpen, dueCheckins, dueCloses, checkinEmail, closedEmail, DAYS, PLANNING_DAYS, GRACE_DAYS };
