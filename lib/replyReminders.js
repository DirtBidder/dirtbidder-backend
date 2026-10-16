// Reminds a client when an operator has messaged them about one of their open jobs and heard nothing back for 2 days.
//   Only for conversations the client has never answered, and only once per operator message.
//   At most one reminder email per client per day; it lists every operator waiting on them.
//   Messages older than 14 days are left alone (the moment has passed).
// Skipped: jobs that aren't open (hired, closed, test) or have new bids paused, suspended and test (+test / +op) accounts.
// Sent only during the day (Central time). To switch it off without a deploy, set REPLY_REMINDERS=off in Railway.
const { sendEmail, SITE } = require('./email');

const TZ = 'America/Chicago';
const WAIT_HOURS = 48;
const MAX_AGE_DAYS = 14;
const TEST = "'\\+(test|op)[0-9]*@'";

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS client_reply_reminders (
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    operator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sent_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, operator_id, message_id))`);
}

// Threads where the newest message is from the operator and has waited long enough, on a real, open job
function dueQuery() {
  return `
    WITH last AS (
      SELECT DISTINCT ON (m.job_id, m.operator_id) m.job_id, m.operator_id, m.id AS message_id, m.sender_id, m.created_at
      FROM messages m
      WHERE m.created_at > NOW() - INTERVAL '${MAX_AGE_DAYS} days'
      ORDER BY m.job_id, m.operator_id, m.id DESC)
    SELECT l.job_id, l.operator_id, l.message_id, j.client_id, j.title,
           cu.email AS client_email, cu.name AS client_name,
           COALESCE(NULLIF(ou.company_name, ''), NULLIF(btrim(ou.name), ''), 'A contractor') AS operator_name
    FROM last l
    JOIN jobs j ON j.id = l.job_id
    JOIN users cu ON cu.id = j.client_id
    JOIN users ou ON ou.id = l.operator_id
    WHERE l.sender_id = l.operator_id
      -- only conversations the client has never answered (no nagging over a "thanks" after a real back-and-forth)
      AND NOT EXISTS (SELECT 1 FROM messages cm WHERE cm.job_id = l.job_id AND cm.operator_id = l.operator_id AND cm.sender_id = j.client_id)
      AND l.created_at <= NOW() - INTERVAL '${WAIT_HOURS} hours'
      AND j.status = 'open' AND NOT COALESCE(j.bids_paused, false) AND NOT COALESCE(j.internal, false)
      AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.job_id = j.id AND b.operator_id = l.operator_id AND b.status = 'withdrawn')
      AND cu.suspended_at IS NULL AND ou.suspended_at IS NULL
      AND cu.email IS NOT NULL AND cu.email <> '' AND cu.email !~* ${TEST} AND ou.email !~* ${TEST}
      AND NOT EXISTS (SELECT 1 FROM client_reply_reminders r
                      WHERE r.job_id = l.job_id AND r.operator_id = l.operator_id AND r.message_id = l.message_id)
      AND NOT EXISTS (SELECT 1 FROM client_reply_reminders r
                      WHERE r.client_id = j.client_id AND r.sent_at > NOW() - INTERVAL '20 hours')
    ORDER BY j.client_id, l.created_at`;
}

function content(rows) {
  const first = String(rows[0].client_name || '').trim().split(/\s+/)[0];
  const names = [...new Set(rows.map(r => r.operator_name))];
  const jobs = [...new Set(rows.map(r => r.title))];
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} contractors`;
  const job = jobs.length === 1 ? `your job "${jobs[0]}"` : 'your jobs';
  const one = rows.length === 1;
  return {
    subject: names.length === 1 ? `${names[0]} is waiting to hear back about ${jobs.length === 1 ? 'your job' : 'your jobs'}` : `${names.length} contractors are waiting to hear back`,
    heading: names.length === 1 ? 'A contractor is waiting on you' : 'Contractors are waiting on you',
    lines: [
      `${first ? 'Hi ' + first + ', ' : ''}${who} sent you ${one ? 'a message' : 'messages'} about ${job} a couple of days ago and ${names.length === 1 ? 'hasn’t' : 'haven’t'} heard back yet.`,
      ...(names.length > 2 ? ['Waiting on you: ' + names.join(', ') + '.'] : []),
      'A quick answer, even “not yet” or “no thanks,” lets them know where things stand. Contractors who hear back are the ones who give you their best price.',
      'Have enough bids already? Open My Jobs and tap “Pause new bids” under the job. You keep the bids you have, and new contractors stop reaching out.'
    ],
    button: {
      label: one ? 'Answer the Message' : 'Answer Messages',
      url: one ? `${SITE}/dirtbidder-messaging.html?job=${rows[0].job_id}&op=${rows[0].operator_id}` : `${SITE}/dirtbidder-messaging.html`
    }
  };
}

// Sends whatever reminders are due. Returns how many emails went out.
async function run(pool, { now = new Date() } = {}) {
  if (String(process.env.REPLY_REMINDERS || '').toLowerCase() === 'off') return 0;
  const hour = Number(now.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;
  if (!(hour >= 8 && hour < 19)) return 0; // 8am to 7pm Central only

  const due = (await pool.query(dueQuery())).rows;
  if (!due.length) return 0;
  const byClient = new Map();
  due.forEach(r => { if (!byClient.has(r.client_id)) byClient.set(r.client_id, []); byClient.get(r.client_id).push(r); });

  let sent = 0;
  for (const [clientId, rows] of byClient) {
    // Record them first, so a second run at the same moment can never email the same client twice
    const marked = [];
    for (const r of rows) {
      const ins = await pool.query(
        `INSERT INTO client_reply_reminders (job_id, operator_id, message_id, client_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING job_id`, [r.job_id, r.operator_id, r.message_id, clientId]);
      if (ins.rows.length) marked.push(r);
    }
    if (!marked.length) continue;
    if (await sendEmail(marked[0].client_email, content(marked))) sent++;
  }
  console.log(`Reply reminders: ${sent} sent (${due.length} unanswered conversation${due.length === 1 ? '' : 's'})`);
  return sent;
}

module.exports = { migrate, run, content, dueQuery };
