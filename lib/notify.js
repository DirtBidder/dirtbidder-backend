// Who gets which email. Every function is fire-and-forget: it never throws into the caller.
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
              cu.email AS client_email, cu.name AS client_name,
              ou.email AS operator_email, COALESCE(NULLIF(ou.company_name, ''), ou.name) AS operator_name
       FROM messages m JOIN jobs j ON j.id = m.job_id JOIN users cu ON cu.id = j.client_id JOIN users ou ON ou.id = m.operator_id
       WHERE m.id = $1`, [messageId]);
    const m = r.rows[0]; if (!m) return;
    const toClient = m.sender_id === m.operator_id;
    const from = toClient ? (m.operator_name || 'The operator') : (m.client_name || 'The client');
    await sendEmail(toClient ? m.client_email : m.operator_email, {
      subject: `New message about "${m.title}"`,
      heading: 'You have a new message',
      lines: [`${from} sent you a message about "${m.title}".`, 'Reply on DirtBidder so everything stays on the job record.'],
      button: { label: 'Read Message', url: `${SITE}/dirtbidder-messaging.html?job=${m.job_id}&op=${m.operator_id}` }
    });
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
      `SELECT e.operator_payout, j.title, ou.email, ou.stripe_account_id
       FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id
       JOIN bids b ON b.id = e.bid_id JOIN users ou ON ou.id = b.operator_id
       WHERE e.job_id = $1 AND e.status = 'released' ORDER BY e.id DESC LIMIT 1`, [jobId]);
    const e = r.rows[0]; if (!e) return;
    await sendEmail(e.email, {
      subject: `Payment released: ${money(e.operator_payout)}`,
      heading: 'You’re getting paid 💵',
      lines: [`The payment for "${e.title}" was released. Your share is ${money(e.operator_payout)} after DirtBidder’s fee.`,
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
