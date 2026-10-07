// Reminds people who signed up but never tapped "Confirm My Email".
//   1st reminder: two days after sign-up.
//   2nd and last: six days after sign-up (and at least three days after the first).
// After that they are left alone. Sent only during the day (Central time), a few at a time.
// Skipped: confirmed, suspended and test (+test / +op) accounts, and accounts older than 45 days.
// To switch it off without a deploy, set CONFIRM_REMINDERS=off in Railway.
const jwt = require('jsonwebtoken');
const { sendEmail } = require('./email');

const TZ = 'America/Chicago';
const API = process.env.API_URL || 'https://dirtbidder-backend-production.up.railway.app';
const BATCH = 25;          // most reminders sent per run (the run repeats every 15 minutes)
const FIRST_AFTER_DAYS = 2;
const LAST_AFTER_DAYS = 6;
const GAP_DAYS = 3;        // least time between the first and the last reminder
const wait = ms => new Promise(r => setTimeout(r, ms));

async function migrate(pool) {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS confirm_reminders INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS confirm_reminded_at TIMESTAMP');
}

function content(u, days) {
  const first = String(u.name || '').trim().split(/\s+/)[0];
  const last = u.confirm_reminders >= 2;
  const when = days >= 6 ? 'about a week ago' : days >= 3 ? 'a few days ago' : 'a couple of days ago';
  const t = jwt.sign({ id: u.id, email: String(u.email).toLowerCase(), confirm: 1 }, process.env.JWT_SECRET || 'change_this_secret', { expiresIn: '30d' });
  return {
    subject: 'One tap left to finish your DirtBidder account',
    heading: 'One tap left',
    lines: [
      `${first ? 'Hi ' + first + ', t' : 'T'}his is Daniel at DirtBidder. You signed up ${when} but haven’t confirmed your email yet. Tap the button below and you’re done.`,
      u.role === 'operator' ? 'You’ll need it before you can bid on a job.' : 'That’s how bids and payment notices reach you.',
      last ? 'This is the last reminder we’ll send. If you didn’t sign up for DirtBidder, you can ignore this email.'
           : 'If you didn’t sign up for DirtBidder, you can ignore this email.'
    ],
    button: { label: 'Confirm My Email', url: API + '/api/confirm-email?t=' + t }
  };
}

// Sends whatever reminders are due. Returns how many went out.
async function run(pool, { now = new Date(), pause = 600 } = {}) {
  if (String(process.env.CONFIRM_REMINDERS || '').toLowerCase() === 'off') return 0;
  const hour = Number(now.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;
  if (!(hour >= 8 && hour < 19)) return 0; // 8am to 7pm Central only (also stops if the clock can't be read)

  // Mark them reminded first, so a second run starting at the same moment can never email the same person twice.
  // If a send then fails, that person simply misses one reminder.
  const due = await pool.query(
    `UPDATE users SET confirm_reminders = confirm_reminders + 1, confirm_reminded_at = NOW()
     WHERE id IN (
       SELECT u.id FROM users u
       WHERE u.email_confirmed_at IS NULL AND u.suspended_at IS NULL
         AND u.email IS NOT NULL AND u.email <> '' AND u.email !~* '\\+(test|op)[0-9]*@'
         AND u.created_at > NOW() - INTERVAL '45 days'
         AND ((u.confirm_reminders = 0 AND u.created_at <= NOW() - INTERVAL '${FIRST_AFTER_DAYS} days')
           OR (u.confirm_reminders = 1 AND u.created_at <= NOW() - INTERVAL '${LAST_AFTER_DAYS} days'
               AND u.confirm_reminded_at <= NOW() - INTERVAL '${GAP_DAYS} days'))
       ORDER BY u.created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
     RETURNING id, email, name, role, confirm_reminders, EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 AS days`);
  if (!due.rows.length) return 0;

  let sent = 0;
  for (const u of due.rows) {
    if (await sendEmail(u.email, content(u, Number(u.days)))) sent++;
    if (pause) await wait(pause);
  }
  const lastOnes = due.rows.filter(u => u.confirm_reminders >= 2).length;
  console.log(`Confirm reminders: ${sent} of ${due.rows.length} sent (${due.rows.length - lastOnes} first, ${lastOnes} last)`);
  return sent;
}

module.exports = { migrate, run, content };
