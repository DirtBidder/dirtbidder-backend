// One-time emails from the owner to a group of users (an announcement, a request).
// Each broadcast has a key. A person is recorded in broadcast_sends BEFORE their email goes out,
// so a restart or a second server can never send anyone the same broadcast twice.
const { sendEmail } = require('./email');

const wait = ms => new Promise(r => setTimeout(r, ms));

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS broadcast_sends (
    key TEXT NOT NULL, email TEXT NOT NULL, user_id INTEGER, sent_at TIMESTAMP DEFAULT NOW(), ok BOOLEAN,
    PRIMARY KEY (key, email))`);
}

// Oct 8 2026 — approved by the owner: ask every contractor to bring their own customers to the site.
const BRING_CUSTOMERS = {
  key: 'operators-bring-customers-2026-10-08',
  ownerCopy: 'daniel@dirtbidder.com',
  recipients: `SELECT u.id, u.email, u.name FROM users u
               WHERE u.role = 'operator' AND u.suspended_at IS NULL
                 AND u.email IS NOT NULL AND u.email <> '' AND u.email !~* '\\+(test|op)[0-9]*@'
                 AND NOT COALESCE(u.internal, false)
                 AND COALESCE(u.profile->>'jobAlerts', 'true') <> 'false'
               ORDER BY u.id`,
  content: name => {
    const first = String(name || '').trim().split(/\s+/)[0];
    return {
      subject: 'Got a customer with dirt work coming up? Put it on DirtBidder',
      heading: 'Bring your customers to DirtBidder',
      orgLine: 'DirtBidder LLC · Iowa',
      lines: [
        `Hi${first ? ' ' + first : ''},`,
        'This is Daniel Wheeler, the founder of DirtBidder. Thanks for signing up. Over 70 contractors joined in the first week, which is more than I hoped for.',
        'Here’s the honest part: jobs are just starting to come in, and the fastest way to change that is you.',
        'You probably have farmers and landowners calling you for prices right now. Next time one does, have them post the job on dirtbidder.com, then put in your bid. Posting is free for them and takes a few minutes.',
        'What you get out of it:',
        '• Your customer pays into escrow before you start, so you’re not chasing money after the work is done.',
        '• You get paid through DirtBidder as soon as the job’s finished.',
        '• Every job you finish builds your reviews, and 4 or 5 stars gets your company a free shoutout on our page.',
        'To be upfront: other contractors can bid on the job too, but your customer picks who they want, and it doesn’t have to be the lowest price. DirtBidder’s fee is 5% or less on each side.',
        'If you have questions, just reply. I read every one.',
        '— Daniel Wheeler, Founder of DirtBidder',
        'If you’d rather not get emails like this, reply and let me know.'
      ],
      button: { label: 'Go to DirtBidder', url: 'https://www.dirtbidder.com' }
    };
  }
};

async function send(pool, b, { pause = 600, log = console.log } = {}) {
  const people = (await pool.query(b.recipients)).rows;
  if (b.ownerCopy) people.push({ id: null, email: b.ownerCopy, name: 'Daniel Wheeler' });
  let sent = 0, skipped = 0, failed = 0;
  for (const p of people) {
    const email = String(p.email).trim().toLowerCase();
    const claim = await pool.query('INSERT INTO broadcast_sends (key, email, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING email', [b.key, email, p.id]);
    if (!claim.rowCount) { skipped++; continue; } // already got this one
    const ok = await sendEmail(p.email, b.content(p.name));
    await pool.query('UPDATE broadcast_sends SET ok = $3 WHERE key = $1 AND email = $2', [b.key, email, ok]);
    if (ok) sent++; else failed++;
    if (pause) await wait(pause);
  }
  log(`Broadcast ${b.key}: ${sent} sent, ${failed} failed, ${skipped} already had it (of ${people.length})`);
  return { sent, failed, skipped, total: people.length };
}

async function runPending(pool) {
  await migrate(pool);
  await send(pool, BRING_CUSTOMERS);
}

module.exports = { migrate, send, runPending, BRING_CUSTOMERS };
