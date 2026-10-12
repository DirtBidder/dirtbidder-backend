// Logins for DirtBidder's lawyer (Matt Nuzum, Surge Business Law) to look around the site, set up once on startup.
//   - a VIEW-ONLY admin login: sees every admin screen, can't change anything, and sees test data only
//   - a TEST CLIENT and a TEST OPERATOR (+test / +op emails): their jobs and bids never reach real users
//   - a sample job with two bids, a question thread where a phone number was hidden, and the flag it raised,
//     so every admin screen has something to show.
// The password comes from LAWYER_DEMO_PASSWORD in Railway (never stored in the code). No password set = nothing happens.
// Emails go to Daniel's own inbox (daniel+...@dirtbidder.com), never to the lawyer.
const bcrypt = require('bcryptjs');
const { scanText } = require('./flags');

const ACCOUNTS = {
  viewer:   { email: 'daniel+lawyerview@dirtbidder.com', role: 'client',   name: 'Matt Nuzum (view only)', viewer: true },
  client:   { email: 'daniel+test90@dirtbidder.com',     role: 'client',   name: 'Matt Nuzum (test client)' },
  operator: { email: 'daniel+op90@dirtbidder.com',       role: 'operator', name: 'Matt Nuzum (test operator)', company: 'Nuzum Test Excavating' },
  sample:   { email: 'daniel+op91@dirtbidder.com',       role: 'operator', name: 'Sample Operator', company: 'Sample Dirt Works (test)' }
};

async function setup(pool) {
  const pw = process.env.LAWYER_DEMO_PASSWORD;
  if (!pw) return;
  const hash = await bcrypt.hash(pw, 10);
  const id = {};
  for (const [key, a] of Object.entries(ACCOUNTS)) {
    // Create once; on later startups only keep the password in step with Railway (so it can be changed there)
    const r = await pool.query(
      `INSERT INTO users (email, password_hash, role, name, company_name, email_confirmed_at, admin_viewer, internal)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id, (xmax = 0) AS created`,
      [a.email, hash, a.role, a.name, a.company || null, !!a.viewer]);
    id[key] = r.rows[0].id;
    if (r.rows[0].created) console.log('[lawyer demo] created', key, 'login', a.email);
  }

  // Sample data, once (marked by the job title)
  const TITLE = 'SAMPLE: Pond cleanout and spread spoils (test job)';
  const have = await pool.query('SELECT id FROM jobs WHERE title = $1 AND client_id = $2', [TITLE, id.client]);
  if (have.rows.length) return;
  const job = await pool.query(
    `INSERT INTO jobs (client_id, title, description, location, job_type, acreage, timeline, budget, status, site_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'test', $9) RETURNING id`,
    [id.client, TITLE,
     'Clean out about 1/2 acre farm pond, haul or spread the spoils on the field to the north, and reshape the bank. This is a sample test job for review; it is hidden from real operators.',
     'Humboldt, IA 50548', 'Pond', '0.5', 'Within a month', 6500, '100 Sample Rd, Humboldt, IA (sample, not a real address)']);
  const jobId = job.rows[0].id;
  // The sample operator asks a question first and tries to give a phone number: the site hides it and flags it
  const q = scanText('Is the pond dry yet or still holding water? Easier to just call me at 515-555-0142 and we can work it out.');
  await pool.query('INSERT INTO messages (job_id, operator_id, sender_id, body, original_body, created_at) VALUES ($1, $2, $2, $3, $4, NOW() - INTERVAL \'2 days\')',
    [jobId, id.sample, q.text, q.reasons.length ? 'Is the pond dry yet or still holding water? Easier to just call me at 515-555-0142 and we can work it out.' : null]);
  await pool.query('INSERT INTO messages (job_id, operator_id, sender_id, body, created_at) VALUES ($1, $2, $3, $4, NOW() - INTERVAL \'2 days\' + INTERVAL \'3 hours\')',
    [jobId, id.sample, id.client, 'Still about a foot of water in the low end. Please keep everything on DirtBidder, thanks.']);
  if (q.reasons.length) {
    await pool.query("INSERT INTO flags (kind, user_id, job_id, reason, details, created_at) VALUES ('message', $1, $2, $3, $4, NOW() - INTERVAL '2 days')",
      [id.sample, jobId, 'Message ' + q.reasons.join(', '), 'Is the pond dry yet or still holding water? Easier to just call me at 515-555-0142 and we can work it out.']);
  }
  await pool.query(
    `INSERT INTO bids (job_id, operator_id, amount, message, est_days, equipment, status, created_at)
     VALUES ($1, $2, 5800, 'Can start once it dries out. Includes spreading spoils on the north field.', 4, 'Excavator, dozer', 'pending', NOW() - INTERVAL '1 day')`,
    [jobId, id.sample]);
  console.log('[lawyer demo] sample job', jobId, 'created');
}

module.exports = { setup, ACCOUNTS };
