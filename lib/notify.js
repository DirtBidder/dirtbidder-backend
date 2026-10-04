// Who gets which email. Every function is fire-and-forget: it never throws into the caller.
const jwt = require('jsonwebtoken');
const { sendEmail, SITE } = require('./email');

const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CLIENT = SITE + '/dirtbidder-client-dashboard.html';
const OPERATOR = SITE + '/dirtbidder-operator-dashboard.html';
const ADMIN = SITE + '/dirtbidder-admin.html';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'daniel@dirtbidder.com').split(',').map(e => e.trim()).filter(Boolean);

// Job with client + hired operator details
async function jobPeople(pool, jobId) {
  const r = await pool.query(
    `SELECT j.id, j.title, cu.email AS client_email, cu.name AS client_name,
            ou.email AS operator_email, COALESCE(NULLIF(ou.company_name, ''), ou.name) AS operator_name, b.amount
     FROM jobs j JOIN users cu ON cu.id = j.client_id
     LEFT JOIN bids b ON b.job_id = j.id AND b.status = 'accepted'
     LEFT JOIN users ou ON ou.id = b.operator_id
     WHERE j.id = $1`, [jobId]);
  return r.rows[0];
}

// Signed link that turns off new-job alerts without logging in
const API = process.env.API_URL || 'https://dirtbidder-backend-production.up.railway.app';
const alertsOffUrl = userId => API + '/api/alerts/unsubscribe?t=' + jwt.sign({ id: userId, alerts: 'off' }, process.env.JWT_SECRET || 'change_this_secret');
const BASE_EMAIL = col => `lower(split_part(split_part(${col}, '@', 1), '+', 1) || '@' || split_part(${col}, '@', 2))`;
const wait = ms => new Promise(r => setTimeout(r, ms));

const safe = fn => (...args) => { Promise.resolve().then(() => fn(...args)).catch(err => console.error('Notify error:', err.message)); };

module.exports = {
  // Operator asked for more money on a job
  changeRequested: safe(async (pool, coId) => {
    const r = await pool.query(
      `SELECT c.amount, c.reason, c.client_total, j.title, cu.email, COALESCE(NULLIF(ou.company_name, ''), ou.name) AS op
       FROM change_orders c JOIN jobs j ON j.id = c.job_id JOIN users cu ON cu.id = j.client_id JOIN users ou ON ou.id = c.operator_id
       WHERE c.id = $1`, [coId]);
    const c = r.rows[0]; if (!c) return;
    await sendEmail(c.email, {
      subject: `Change request on "${c.title}": +${money(c.amount)}`,
      heading: 'Your operator is asking for more',
      lines: [`${c.op || 'Your operator'} is asking for ${money(c.amount)} more on "${c.title}".`, `Their reason: "${String(c.reason).slice(0, 400)}"`,
        `If you approve, you'll pay ${money(c.client_total)} (including the DirtBidder fee) into escrow. It's held with the rest of the job and only released when you say the job is done.`,
        'You can also decline. The operator then finishes at the original price, or you can report a problem.'],
      button: { label: 'Review the Request', url: CLIENT }
    });
  }),
  // Client approved (paid) or declined a change request
  changeDecided: safe(async (pool, coId) => {
    const r = await pool.query(
      `SELECT c.status, c.amount, c.client_note, j.title, ou.email
       FROM change_orders c JOIN jobs j ON j.id = c.job_id JOIN users ou ON ou.id = c.operator_id WHERE c.id = $1`, [coId]);
    const c = r.rows[0]; if (!c) return;
    const yes = c.status === 'paid' || c.status === 'approved';
    await sendEmail(c.email, {
      subject: yes ? `Approved: +${money(c.amount)} on "${c.title}"` : `Change request declined on "${c.title}"`,
      heading: yes ? 'Change approved and funded 👍' : 'Change request declined',
      lines: yes
        ? [`The client approved your ${money(c.amount)} change on "${c.title}" and paid it into escrow.`, 'It’s released to you with the rest of the job when the client releases payment.']
        : [`The client declined your ${money(c.amount)} change request on "${c.title}".`, ...(c.client_note ? [`Their note: "${String(c.client_note).slice(0, 400)}"`] : []),
           'You can message the client to work it out, or finish at the original price.'],
      button: { label: 'Open Dashboard', url: OPERATOR }
    });
  }),

  // A bank payment went over Stripe's ACH limit: tell the owner to ask Stripe for more
  bankLimit: safe(async (pool, { jobId, amount, stage, detail }) => {
    const j = jobId ? (await pool.query(
      'SELECT j.title, u.name, u.email FROM jobs j JOIN users u ON u.id = j.client_id WHERE j.id = $1', [jobId])).rows[0] : null;
    for (const to of ADMIN_EMAILS) {
      await sendEmail(to, {
        subject: `Action needed: a ${money(amount)} bank payment hit your Stripe limit`,
        heading: 'A client couldn’t pay — bank limit reached',
        lines: [
          `${j ? (j.name || j.email) + ' tried to pay ' : 'A client tried to pay '}${money(amount)}${j ? ` for "${j.title}"` : ''}, but Stripe stopped it ${stage} because it’s over your ACH Direct Debit limit.`,
          ...(detail ? [`Stripe said: "${String(detail).slice(0, 300)}"`] : []),
          'To fix it: Stripe Dashboard → Settings → Payments → Payment methods → ACH Direct Debit → Increase limit. Explain that DirtBidder is an escrow marketplace for earthwork jobs that often run $10,000–$250,000.',
          ...(j ? [`Once it’s raised, let ${j.name || 'the client'} know they can pay (${j.email}). Their job and bids are saved.`] : [])
        ],
        button: { label: 'Open Stripe', url: 'https://dashboard.stripe.com/settings/payment_methods' }
      });
    }
  }),

  // ── Bank (ACH) payments ──
  // Client finished a bank payment for a hire: it takes a few business days to clear
  fundingStarted: safe(async (pool, escrowId) => {
    const e = (await pool.query('SELECT job_id, client_total FROM escrow_transactions WHERE id = $1', [escrowId])).rows[0]; if (!e) return;
    const p = await jobPeople(pool, e.job_id); if (!p) return;
    await sendEmail(p.client_email, {
      subject: `Bank payment started: ${p.title}`,
      heading: 'Your bank payment is on its way',
      lines: [`You chose ${p.operator_name || 'your operator'} for "${p.title}" and paid ${money(e.client_total)} by bank transfer.`, 'Bank payments take about 4 business days to clear. We’ll email you and the operator as soon as it does, and the money is then held in escrow until you release it.'],
      button: { label: 'Open Dashboard', url: CLIENT }
    });
    if (p.operator_email) await sendEmail(p.operator_email, {
      subject: `You've been picked: ${p.title} (payment clearing)`,
      heading: 'You’ve been picked 🚜 — wait for the payment to clear',
      lines: [`${p.client_name || 'The client'} chose your ${money(p.amount)} bid on "${p.title}" and paid by bank transfer.`, 'Bank payments take about 4 business days to clear. Please don’t start work yet — we’ll email you the moment it clears and the money is secured in escrow.'],
      button: { label: 'Open Dashboard', url: OPERATOR }
    });
  }),
  // Client's bank payment for a hire cleared (the operator gets the normal "You're hired" email)
  fundingCleared: safe(async (pool, escrowId) => {
    const e = (await pool.query('SELECT job_id FROM escrow_transactions WHERE id = $1', [escrowId])).rows[0]; if (!e) return;
    const p = await jobPeople(pool, e.job_id); if (!p) return;
    await sendEmail(p.client_email, {
      subject: `Payment cleared: ${p.title}`,
      heading: 'Your payment cleared ✅',
      lines: [`Your bank payment for "${p.title}" cleared and is held in escrow. ${p.operator_name || 'Your operator'} has been told to start.`],
      button: { label: 'Open Dashboard', url: CLIENT }
    });
  }),
  // Client's bank payment for a hire failed: job reopened
  fundingFailed: safe(async (pool, escrowId) => {
    const e = (await pool.query(
      `SELECT e.job_id, j.title, cu.email AS client_email, ou.email AS operator_email
       FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id JOIN users cu ON cu.id = j.client_id
       LEFT JOIN bids b ON b.id = e.bid_id LEFT JOIN users ou ON ou.id = b.operator_id WHERE e.id = $1`, [escrowId])).rows[0]; if (!e) return;
    await sendEmail(e.client_email, {
      subject: `Bank payment didn't go through: ${e.title}`,
      heading: 'Your bank payment failed',
      lines: [`Your bank payment for "${e.title}" didn’t go through (for example, not enough funds or the account was closed). Nobody has been hired yet.`, 'Your job and its bids are open again. Accept a bid to try paying again.'],
      button: { label: 'Open Dashboard', url: CLIENT }
    });
    if (e.operator_email) await sendEmail(e.operator_email, {
      subject: `Update on "${e.title}": client's payment failed`,
      heading: 'The client’s payment didn’t go through',
      lines: [`The client’s bank payment for "${e.title}" failed, so the hire didn’t go through. Please don’t start work.`, 'Your bid is still in. If the client pays again, we’ll let you know.'],
      button: { label: 'Open Dashboard', url: OPERATOR }
    });
  }),
  // Change order paid by bank: clearing
  changeProcessing: safe(async (pool, coId) => {
    const c = (await pool.query(
      `SELECT c.amount, j.title, ou.email FROM change_orders c JOIN jobs j ON j.id = c.job_id JOIN users ou ON ou.id = c.operator_id WHERE c.id = $1`, [coId])).rows[0]; if (!c) return;
    await sendEmail(c.email, {
      subject: `Approved, payment clearing: +${money(c.amount)} on "${c.title}"`,
      heading: 'Change approved — payment clearing',
      lines: [`The client approved your ${money(c.amount)} change on "${c.title}" and paid by bank transfer.`, 'It takes about 4 business days to clear. Hold off on the extra work until we email you that it cleared.'],
      button: { label: 'Open Dashboard', url: OPERATOR }
    });
  }),
  // Change order bank payment failed
  changeFailed: safe(async (pool, coId) => {
    const c = (await pool.query(
      `SELECT c.amount, j.title, cu.email AS client_email, ou.email AS operator_email
       FROM change_orders c JOIN jobs j ON j.id = c.job_id JOIN users cu ON cu.id = j.client_id JOIN users ou ON ou.id = c.operator_id WHERE c.id = $1`, [coId])).rows[0]; if (!c) return;
    await sendEmail(c.client_email, {
      subject: `Bank payment didn't go through: change on "${c.title}"`,
      heading: 'Your change-order payment failed',
      lines: [`Your bank payment for the ${money(c.amount)} change on "${c.title}" didn’t go through.`, 'The request is waiting on you again. You can approve and pay again, or decline it.'],
      button: { label: 'Open Dashboard', url: CLIENT }
    });
    await sendEmail(c.operator_email, {
      subject: `Change payment failed on "${c.title}"`,
      heading: 'The client’s payment didn’t go through',
      lines: [`The client’s bank payment for your ${money(c.amount)} change on "${c.title}" failed. Don’t do the extra work until it’s paid.`],
      button: { label: 'Open Dashboard', url: OPERATOR }
    });
  }),

  // A real client tried to hire while payments are still in test mode
  paymentsWaitlist: safe(async (pool, bidId) => {
    const r = await pool.query(
      `SELECT b.amount, j.title, cu.name, cu.email, COALESCE(NULLIF(ou.company_name, ''), ou.name) AS op
       FROM bids b JOIN jobs j ON j.id = b.job_id JOIN users cu ON cu.id = j.client_id JOIN users ou ON ou.id = b.operator_id
       WHERE b.id = $1`, [bidId]);
    const b = r.rows[0]; if (!b) return;
    for (const to of ADMIN_EMAILS) {
      await sendEmail(to, {
        subject: `Someone wants to hire on DirtBidder — turn on live payments`,
        heading: 'A client is waiting to pay',
        lines: [`${b.name || b.email} tried to hire ${b.op || 'an operator'} for ${money(b.amount)} on "${b.title}".`, 'Payments are still in test mode, so they were told payments open soon and added to the waitlist.', 'Once Stripe is live, email them that they can hire now.'],
        button: { label: 'Open HQ', url: SITE + '/dirtbidder-hq.html' }
      });
    }
  }),

  // New message: email the other side a heads-up (not the text itself — they read it on the site)
  newMessage: safe(async (pool, messageId) => {
    const r = await pool.query(
      `SELECT m.sender_id, m.operator_id, j.id AS job_id, j.title, j.client_id,
              NOT EXISTS (SELECT 1 FROM bids b WHERE b.job_id = m.job_id AND b.operator_id = m.operator_id) AS asking,
              cu.email AS client_email, cu.name AS client_name,
              ou.email AS operator_email, COALESCE(NULLIF(ou.company_name, ''), ou.name) AS operator_name
       FROM messages m JOIN jobs j ON j.id = m.job_id JOIN users cu ON cu.id = j.client_id JOIN users ou ON ou.id = m.operator_id
       WHERE m.id = $1`, [messageId]);
    const m = r.rows[0]; if (!m) return;
    const toClient = m.sender_id === m.operator_id;
    const from = toClient ? (m.operator_name || 'The operator') : (m.client_name || 'The client');
    await sendEmail(toClient ? m.client_email : m.operator_email, {
      subject: m.asking && toClient ? `Question about your job "${m.title}"` : `New message about "${m.title}"`,
      heading: m.asking && toClient ? 'An operator has a question' : 'You have a new message',
      lines: [m.asking && toClient ? `${from} has a question about "${m.title}" before bidding. A quick answer helps them give you an accurate price.` : `${from} sent you a message about "${m.title}".`, 'Reply on DirtBidder so everything stays on the job record.'],
      button: { label: 'Read Message', url: `${SITE}/dirtbidder-messaging.html?job=${m.job_id}&op=${m.operator_id}` }
    });
  }),

  // "Confirm your email" link for a new account (or a resend). Does nothing once the address is confirmed.
  confirmEmail: safe(async (pool, userId, opts = {}) => {
    const u = (await pool.query('SELECT id, email, name, role, email_confirmed_at FROM users WHERE id = $1', [userId])).rows[0];
    if (!u || u.email_confirmed_at || !u.email) return;
    const t = jwt.sign({ id: u.id, email: String(u.email).toLowerCase(), confirm: 1 }, process.env.JWT_SECRET || 'change_this_secret', { expiresIn: '30d' });
    const first = String(u.name || '').trim().split(/\s+/)[0];
    const button = { label: 'Confirm My Email', url: API + '/api/confirm-email?t=' + t };
    // At sign-up this doubles as the welcome note from the founder, so a new user gets one email, not two
    if (opts.welcome) {
      const op = u.role === 'operator';
      return sendEmail(u.email, {
        subject: 'Welcome to DirtBidder — please confirm your email',
        heading: `Welcome to DirtBidder${first ? ', ' + first : ''}`,
        lines: [
          'This is Daniel Wheeler, the founder of DirtBidder. Thank you for signing up. We just launched, and you’re one of the first people on the site, which means a lot to me.',
          'First, tap the button below to confirm this is your email address. ' + (op ? 'You’ll need that before you can bid or message a client.' : 'That’s how bids and payment notices reach you.'),
          ...(op ? [
            'What to expect as an operator:',
            '• You’ll get an email the moment a new job is posted, so you don’t have to keep checking the site.',
            '• You can ask the client questions before you bid, and they can share the job location so you can look at the site first.',
            '• You can change your bid any time before the client accepts it.',
            'We’re new, so jobs are just starting to come in. If you know a farmer or landowner with dirt work coming up, send them our way. Posting a job is free for them, and you’d be first in line to bid.'
          ] : [
            'What to expect as a client:',
            '• Post your job in a few minutes. It’s free, and you’re not committed to anything.',
            '• Operators can ask you questions and send bids. You pick who you want.',
            '• Your payment is held in escrow and only released when you say the job is done.'
          ]),
          'If anything is confusing or doesn’t work right, reply to this email and tell me. I read every one.',
          '— Daniel Wheeler, Founder'
        ],
        button
      });
    }
    await sendEmail(u.email, {
      subject: 'Confirm your email for DirtBidder',
      heading: 'Confirm your email',
      lines: [`${first ? 'Hi ' + first + ', t' : 'T'}hanks for joining DirtBidder. Tap the button to confirm this is your email address.`,
        'Job alerts, bids and payment notices come to this address, so it needs to be right.',
        'If you didn’t sign up for DirtBidder, you can ignore this email.'],
      button
    });
  }),

  // Tell the owner each time a real person signs up (test accounts are skipped)
  newSignup: safe(async (pool, userId) => {
    const u = (await pool.query('SELECT id, email, name, phone, role, company_name, profile FROM users WHERE id = $1', [userId])).rows[0];
    if (!u || /\+(test|op)\d*@/i.test(u.email || '')) return;
    const p = u.profile || {};
    const who = String(u.company_name || '').trim() || String(u.name || '').trim() || u.email;
    const op = u.role === 'operator';
    const counts = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE role = 'operator')::int AS operators, COUNT(*) FILTER (WHERE role = 'client')::int AS clients
       FROM users WHERE email !~* '\\+(test|op)[0-9]*@' AND NOT COALESCE(internal, false)`)).rows[0];
    const lines = [
      `${who} just signed up as ${op ? 'an operator' : 'a client'}.`,
      [u.name && u.company_name ? 'Name: ' + u.name : '', 'Email: ' + u.email, u.phone ? 'Phone: ' + u.phone : ''].filter(Boolean).join(' · '),
      op ? [p.zip ? 'ZIP ' + p.zip : '', p.serviceRadius ? 'travels ' + String(p.serviceRadius).toLowerCase() : '', p.yearsExp ? p.yearsExp + ' experience' : ''].filter(Boolean).join(' · ')
         : [p.city, p.zip ? 'ZIP ' + p.zip : '', p.jobType ? 'needs: ' + p.jobType : '', p.acreage, p.timeline].filter(Boolean).join(' · '),
      op && Array.isArray(p.equipment) && p.equipment.length ? 'Equipment: ' + p.equipment.slice(0, 12).join(', ') : '',
      'They were sent the welcome email with a link to confirm their address.',
      `That makes ${counts.operators} operator${counts.operators === 1 ? '' : 's'} and ${counts.clients} client${counts.clients === 1 ? '' : 's'} (not counting your own and test accounts).`
    ].filter(Boolean);
    for (const to of ADMIN_EMAILS) {
      await sendEmail(to, { subject: `New ${op ? 'operator' : 'client'} on DirtBidder: ${who}`, heading: `New ${op ? 'operator' : 'client'} sign-up`, lines,
        button: { label: 'See Users', url: ADMIN + '#users' } });
    }
  }),

  // A job was posted: tell operators so they come back and bid.
  // Real jobs go to every active operator who hasn't turned alerts off. Test jobs only go to the tester's own operator accounts.
  newJob: safe(async (pool, jobId) => {
    const jr = await pool.query(
      `SELECT j.id, j.title, j.description, j.location, j.job_type, j.acreage, j.timeline, j.budget, j.status, j.client_id, cu.email AS client_email
       FROM jobs j JOIN users cu ON cu.id = j.client_id WHERE j.id = $1`, [jobId]);
    const j = jr.rows[0]; if (!j || !['open', 'test'].includes(j.status)) return;
    const ops = await pool.query(
      `SELECT u.id, u.email, u.name FROM users u
       WHERE u.role = 'operator' AND u.suspended_at IS NULL AND u.id <> $1
         AND COALESCE(u.profile->>'jobAlerts', 'true') <> 'false'
         AND ${j.status === 'test'
            ? `${BASE_EMAIL('u.email')} = ${BASE_EMAIL('$2')}`
            : `u.email !~* '\\+(test|op)[0-9]*@' AND $2::text IS NOT NULL`}
       ORDER BY u.id`, [j.client_id, j.client_email]);
    const facts = [j.job_type, j.location, j.acreage, j.timeline && 'Timeline: ' + j.timeline, Number(j.budget) > 0 && 'Budget: ' + money(j.budget).replace(/\.00$/, '')].filter(Boolean).join(' · ');
    const desc = String(j.description || '').split('\n')[0].trim();
    for (const o of ops.rows) {
      const off = alertsOffUrl(o.id);
      await sendEmail(o.email, {
        subject: `New job on DirtBidder: ${j.title}${j.location ? ' (' + j.location + ')' : ''}`,
        heading: 'A new job was just posted',
        lines: [`"${j.title}"`, facts, desc && (desc.length > 300 ? desc.slice(0, 300) + '…' : desc),
          'Bids are sealed, so other operators can’t see your number. It’s free to bid.'].filter(Boolean),
        button: { label: 'See the Job and Bid', url: OPERATOR + '#browse' },
        footer: { text: 'You get this because you’re an operator on DirtBidder.', label: 'Turn off new-job emails', url: off },
        headers: { 'List-Unsubscribe': `<${off}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      });
      await wait(600); // stay under the email provider's per-second limit
    }
  }),

  newBid: safe(async (pool, bidId) => {
    const r = await pool.query(
      `SELECT b.amount, b.est_days, j.title, cu.email, COALESCE(NULLIF(ou.company_name, ''), ou.name) AS op
       FROM bids b JOIN jobs j ON j.id = b.job_id JOIN users cu ON cu.id = j.client_id JOIN users ou ON ou.id = b.operator_id
       WHERE b.id = $1`, [bidId]);
    const b = r.rows[0]; if (!b) return;
    await sendEmail(b.email, {
      subject: `New bid on "${b.title}": ${money(b.amount)}`,
      heading: 'You have a new bid',
      lines: [`${b.op || 'An operator'} bid ${money(b.amount)}${b.est_days ? ' (' + b.est_days + ' days)' : ''} on "${b.title}".`, 'Compare bids and hire when you’re ready. Nothing is charged until you accept one.'],
      button: { label: 'Review Bids', url: CLIENT }
    });
  }),

  // Operator changed their number on a bid the client hasn't accepted yet
  bidUpdated: safe(async (pool, bidId, was) => {
    const r = await pool.query(
      `SELECT b.amount, b.est_days, j.title, cu.email, COALESCE(NULLIF(ou.company_name, ''), ou.name) AS op
       FROM bids b JOIN jobs j ON j.id = b.job_id JOIN users cu ON cu.id = j.client_id JOIN users ou ON ou.id = b.operator_id
       WHERE b.id = $1`, [bidId]);
    const b = r.rows[0]; if (!b) return;
    await sendEmail(b.email, {
      subject: `Bid updated on "${b.title}": now ${money(b.amount)}`,
      heading: 'A bid was updated',
      lines: [`${b.op || 'An operator'} changed their bid on "${b.title}" from ${money(was)} to ${money(b.amount)}.`, 'Nothing is charged until you accept a bid.'],
      button: { label: 'Review Bids', url: CLIENT }
    });
  }),

  // Client shared the job's exact location with an operator before hiring, so they can go look at the site
  locationShared: safe(async (pool, jobId, operatorId) => {
    const r = await pool.query(
      `SELECT j.title, cu.name AS client_name, ou.email FROM jobs j JOIN users cu ON cu.id = j.client_id JOIN users ou ON ou.id = $2 WHERE j.id = $1`, [jobId, operatorId]);
    const x = r.rows[0]; if (!x) return;
    await sendEmail(x.email, {
      subject: `Job location shared: ${x.title}`,
      heading: 'You can go look at the site',
      lines: [`${x.client_name || 'The client'} shared the exact location of "${x.title}" with you, so you can see the site before you price it.`,
        'Open the conversation to get the address and directions. You can update your bid any time before the client accepts it.',
        'Phone numbers and emails are shared once you’re hired and paid through DirtBidder.'],
      button: { label: 'Get the Location', url: `${SITE}/dirtbidder-messaging.html?job=${jobId}&op=${operatorId}` }
    });
  }),

  hired: safe(async (pool, jobId) => {
    const p = await jobPeople(pool, jobId); if (!p || !p.operator_email) return;
    await sendEmail(p.operator_email, {
      subject: `You're hired: ${p.title}`,
      heading: 'You got the job 🚜',
      lines: [`${p.client_name || 'The client'} accepted your ${money(p.amount)} bid on "${p.title}".`, 'The payment is secured in escrow. The exact job address and the client’s contact info are now on your dashboard under Active Jobs.', 'When the work is done, mark the job complete there.'],
      button: { label: 'Open Dashboard', url: OPERATOR }
    });
    const others = await pool.query(
      `SELECT u.email FROM bids b JOIN users u ON u.id = b.operator_id WHERE b.job_id = $1 AND b.status = 'declined'`, [jobId]);
    for (const o of others.rows) {
      await sendEmail(o.email, {
        subject: `Update on "${p.title}"`,
        heading: 'This job went to another operator',
        lines: [`The client chose a different bid for "${p.title}". Thanks for bidding — new jobs are posted all the time.`],
        button: { label: 'Browse Jobs', url: OPERATOR }
      });
    }
  }),

  markedComplete: safe(async (pool, jobId) => {
    const p = await jobPeople(pool, jobId); if (!p) return;
    await sendEmail(p.client_email, {
      subject: `Job marked complete: ${p.title}`,
      heading: 'Your operator says the job is done',
      lines: [`${p.operator_name || 'Your operator'} marked "${p.title}" complete.`, 'Check the work, then release the payment — or report a problem. If you don’t do either within 72 hours, the payment releases to the operator automatically.'],
      button: { label: 'Review & Release', url: CLIENT }
    });
  }),

  askForReview: safe(async (pool, jobId) => {
    const p = await jobPeople(pool, jobId); if (!p || !p.operator_name) return;
    await sendEmail(p.client_email, {
      subject: `How did ${p.operator_name} do?`,
      heading: 'Rate your operator',
      lines: [`"${p.title}" is complete and ${p.operator_name} has been paid.`, 'Take 10 seconds to leave a star rating. It helps other people in your area pick good operators — and helps good operators earn badges.'],
      button: { label: 'Leave a Rating', url: CLIENT }
    });
  }),

  newReview: safe(async (pool, reviewId) => {
    const r = await pool.query(
      `SELECT rv.rating, rv.comment, j.title, ou.email FROM reviews rv JOIN jobs j ON j.id = rv.job_id
       JOIN users ou ON ou.id = rv.reviewee_id WHERE rv.id = $1`, [reviewId]);
    const v = r.rows[0]; if (!v) return;
    await sendEmail(v.email, {
      subject: `New ${v.rating}-star review`,
      heading: `You got a ${'★'.repeat(v.rating)}${'☆'.repeat(5 - v.rating)} review`,
      lines: [`For "${v.title}".`, v.comment ? `The client wrote: "${v.comment}"` : 'No comment was left.'],
      button: { label: 'See My Reviews', url: OPERATOR }
    });
  }),

  jobClosed: safe(async (pool, jobId, operatorIds) => {
    if (!operatorIds || !operatorIds.length) return;
    const j = await pool.query('SELECT title FROM jobs WHERE id = $1', [jobId]);
    const title = j.rows[0] ? j.rows[0].title : 'a job';
    const ops = await pool.query('SELECT email FROM users WHERE id = ANY($1::int[])', [operatorIds]);
    for (const o of ops.rows) {
      await sendEmail(o.email, {
        subject: `Job closed: ${title}`,
        heading: 'This job was taken down',
        lines: [`The client closed "${title}" without hiring anyone, so your bid is no longer active. New jobs are posted all the time.`],
        button: { label: 'Browse Jobs', url: OPERATOR }
      });
    }
  }),

  cancelledByAgreement: safe(async (pool, jobId, refundAmount) => {
    const p = await jobPeople(pool, jobId); if (!p) return;
    await sendEmail(p.client_email, {
      subject: `Job cancelled and refunded: ${p.title}`,
      heading: 'Your refund is on the way',
      lines: [`"${p.title}" was cancelled and you’re being refunded ${money(refundAmount)} to your card, including the DirtBidder fee. It usually shows up in 5–10 business days.`],
      button: { label: 'Open Dashboard', url: CLIENT }
    });
    if (p.operator_email) await sendEmail(p.operator_email, {
      subject: `Job cancelled: ${p.title}`,
      heading: 'This job was cancelled',
      lines: [`"${p.title}" was cancelled before work started, and the client was refunded. No payment will be sent for this job.`],
      button: { label: 'Open Dashboard', url: OPERATOR }
    });
  }),

  accountWarning: safe(async (pool, userId, reason) => {
    const u = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]); if (!u.rows[0]) return;
    await sendEmail(u.rows[0].email, {
      subject: 'Warning about your DirtBidder account',
      heading: 'A warning about your account',
      lines: [`Hi ${(u.rows[0].name || '').split(' ')[0] || 'there'}, we’re writing because something on your account goes against DirtBidder’s rules:`, `"${reason}"`,
        'Your account is still active. Please don’t let this happen again — repeated problems can lead to your account being suspended.',
        'If you think this is a mistake, just reply to this email.'],
      button: { label: 'Read the Rules', url: SITE + '/dirtbidder-terms.html' }
    });
  }),

  accountSuspended: safe(async (pool, userId, reason) => {
    const u = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]); if (!u.rows[0]) return;
    await sendEmail(u.rows[0].email, {
      subject: 'Your DirtBidder account has been suspended',
      heading: 'Your account is suspended',
      lines: [`Hi ${(u.rows[0].name || '').split(' ')[0] || 'there'}, your DirtBidder account has been suspended for breaking our rules:`, `"${reason}"`,
        'You can’t sign in while it’s suspended, and your open jobs and bids have been taken down. Any payment already in escrow will still be handled fairly — we’ll contact you about it if needed.',
        'If you think this is a mistake, reply to this email.'],
      button: { label: 'Read the Rules', url: SITE + '/dirtbidder-terms.html' }
    });
  }),

  accountRestored: safe(async (pool, userId) => {
    const u = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]); if (!u.rows[0]) return;
    await sendEmail(u.rows[0].email, {
      subject: 'Your DirtBidder account is active again',
      heading: 'Welcome back',
      lines: [`Hi ${(u.rows[0].name || '').split(' ')[0] || 'there'}, your DirtBidder account has been restored and you can sign in again.`, 'Jobs or bids that were taken down while it was suspended stay down — you can post or bid again any time.'],
      button: { label: 'Sign In', url: SITE + '/dirtbidder-login.html' }
    });
  }),

  adminFlag: safe(async (pool, flagId) => {
    const r = await pool.query(
      `SELECT f.kind, f.reason, u.email, COALESCE(NULLIF(u.company_name, ''), u.name) AS who, j.title
       FROM flags f JOIN users u ON u.id = f.user_id LEFT JOIN jobs j ON j.id = f.job_id WHERE f.id = $1`, [flagId]);
    const f = r.rows[0]; if (!f) return;
    const what = { bid: 'Bid flagged', job: 'Job post flagged', profile: 'Profile flagged', report: 'User reported', pattern: 'Suspicious pattern', message: 'Message flagged' }[f.kind] || 'Flag';
    for (const a of ADMIN_EMAILS) await sendEmail(a, {
      subject: `🚩 ${what}: ${f.who || f.email}`,
      heading: `🚩 ${what}`,
      lines: [`${f.who || 'A user'} (${f.email})${f.title ? ` · job "${f.title}"` : ''}`, f.reason, 'Review it on the Flagged tab and decide: warn, suspend, or dismiss.'],
      button: { label: 'Open Flagged', url: ADMIN }
    });
  }),

  released: safe(async (pool, jobId) => {
    const r = await pool.query(
      `SELECT SUM(e.operator_payout)::float AS operator_payout, COUNT(*)::int AS n, j.title, ou.email, ou.stripe_account_id
       FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id
       JOIN bids b ON b.id = e.bid_id JOIN users ou ON ou.id = b.operator_id
       WHERE e.job_id = $1 AND e.status = 'released'
       GROUP BY j.title, ou.email, ou.stripe_account_id`, [jobId]);
    const e = r.rows[0]; if (!e) return;
    await sendEmail(e.email, {
      subject: `Payment released: ${money(e.operator_payout)}`,
      heading: 'You’re getting paid 💵',
      lines: [`The payment for "${e.title}" was released. Your share is ${money(e.operator_payout)} after DirtBidder’s fee${e.n > 1 ? ' (includes approved change orders)' : ''}.`,
        e.stripe_account_id ? 'It’s on its way to your bank.' : 'Set up payouts on your dashboard so we can send it to your bank.'],
      button: { label: e.stripe_account_id ? 'View Earnings' : 'Set Up Payouts', url: OPERATOR }
    });
  }),

  disputeOpened: safe(async (pool, disputeId) => {
    const r = await pool.query('SELECT job_id, reason FROM disputes WHERE id = $1', [disputeId]);
    const d = r.rows[0]; if (!d) return;
    const p = await jobPeople(pool, d.job_id); if (!p) return;
    if (p.operator_email) await sendEmail(p.operator_email, {
      subject: `Problem reported on "${p.title}"`,
      heading: 'The client reported a problem',
      lines: [`The client says: "${d.reason}"`, 'Your payment is on hold while DirtBidder reviews it. Please send your side from your dashboard so we can decide fairly.'],
      button: { label: 'Send My Side', url: OPERATOR }
    });
    for (const a of ADMIN_EMAILS) await sendEmail(a, {
      subject: `[Admin] New dispute: ${p.title}`,
      heading: 'New dispute to review',
      lines: [`Job: ${p.title} (${money(p.amount)})`, `Client: ${p.client_name || ''} <${p.client_email}>`, `Operator: ${p.operator_name || ''} <${p.operator_email || ''}>`, `Reason: ${d.reason}`],
      button: { label: 'Open Admin', url: ADMIN }
    });
  }),

  disputeResolved: safe(async (pool, disputeId) => {
    const r = await pool.query('SELECT job_id, resolution, refund_amount, operator_amount, admin_note FROM disputes WHERE id = $1', [disputeId]);
    const d = r.rows[0]; if (!d) return;
    const p = await jobPeople(pool, d.job_id); if (!p) return;
    const note = d.admin_note ? `Note from DirtBidder: "${d.admin_note}"` : null;
    const clientLine = { release: 'The payment was released to the operator.', refund: `You’re being refunded ${money(d.refund_amount)} to your card (usually 5–10 business days).`, split: `You’re being refunded ${money(d.refund_amount)} to your card, and the operator was paid for part of the work.` }[d.resolution];
    const opLine = { release: 'The full payment was released to you.', refund: 'The client was refunded, so no payment will be sent for this job.', split: `You were paid ${money(d.operator_amount)} (before fees) for part of the work.` }[d.resolution];
    await sendEmail(p.client_email, { subject: `Dispute decided: ${p.title}`, heading: 'We’ve made a decision', lines: [clientLine, note].filter(Boolean), button: { label: 'Open Dashboard', url: CLIENT } });
    if (p.operator_email) await sendEmail(p.operator_email, { subject: `Dispute decided: ${p.title}`, heading: 'We’ve made a decision', lines: [opLine, note].filter(Boolean), button: { label: 'Open Dashboard', url: OPERATOR } });
  })
};
