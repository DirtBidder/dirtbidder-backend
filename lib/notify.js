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
      lines: [`${p.client_name || 'The client'} accepted your ${money(p.amount)} bid on "${p.title}".`, 'The payment is secured in escrow. When the work is done, mark the job complete on your dashboard.'],
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
