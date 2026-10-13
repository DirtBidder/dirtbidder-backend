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

// Oct 12 2026 — tell every contractor about the new Public Bid Board (county, city and Iowa DOT jobs).
const PUBLIC_BID_BOARD = {
  key: 'operators-public-bid-board-2026-10-12',
  ownerCopy: 'daniel@dirtbidder.com',
  recipients: BRING_CUSTOMERS.recipients,
  content: name => {
    const first = String(name || '').trim().split(/\s+/)[0];
    return {
      subject: 'New on DirtBidder: county and Iowa DOT dirt jobs in one free list',
      heading: 'The Public Bid Board is up',
      orgLine: 'DirtBidder LLC · Iowa',
      lines: [
        `Hi${first ? ' ' + first : ''},`,
        'Daniel here from DirtBidder. We just added something new for contractors: the Public Bid Board.',
        'WHAT IT IS',
        'One list of upcoming Iowa county, city and Iowa DOT jobs that have dirt work in them: grading, excavation, culverts, ditches, drainage and seeding. Normally you’d have to dig through the DOT website and county websites to find these. Now they’re in one place, soonest bid date first.',
        'What’s on it right now: 14 jobs, including Iowa DOT jobs bidding Oct 20 in Humboldt, Webster (Fort Dodge), Greene, Story, Marshall, Lyon, Fremont and Bremer counties, a box culvert in Adair County, and upcoming ones in Pocahontas, Webster, Sac and Calhoun counties.',
        'HOW TO USE IT',
        '1. Tap the button below, or tap Public Bids in the menu on your DirtBidder dashboard.',
        '2. Search by county, road or type of work. Try your county, or a word like “culvert.”',
        '3. Each job shows the bid date, who’s letting it, where it is, what dirt work is in it, and the bid bond if there is one.',
        '4. Tap “Open the official notice” to see the agency’s notice with the plans, specs and exact deadline. Always go by the notice.',
        '5. Bid with the agency directly, the way their notice says. These jobs are not bid through DirtBidder.',
        'ADVERTISED OR ESTIMATED',
        '• Advertised: the notice is out. You can get plans and bid now.',
        '• Estimated: on the Iowa DOT’s list of upcoming projects but not advertised yet. The date can move. Plans usually post about 3 weeks before the bid date.',
        'WHAT YOU’LL USUALLY NEED FOR PUBLIC WORK',
        '• A bid bond (bid security) turned in with your bid.',
        '• For Iowa DOT jobs: DOT prequalification and a Bid Express account (bidx.com), set up before the bid date.',
        '• If you win: a performance bond and proof of insurance.',
        '• Smaller county jobs are often simpler. Call the county engineer’s office listed on the notice and ask what they need.',
        'WHAT IT COSTS',
        'Nothing. DirtBidder doesn’t charge anything for public jobs and isn’t part of the bidding. Our fee of 5% or less only applies to private jobs posted and paid on DirtBidder.',
        'New jobs get added as they’re announced, and old ones drop off after the bid date. Know of a county, city or drainage district job we missed? Reply and tell me, and I’ll add it.',
        '— Daniel Wheeler, Founder of DirtBidder',
        'If you’d rather not get emails like this, reply and let me know.'
      ],
      button: { label: 'See the Public Bid Board', url: 'https://www.dirtbidder.com/dirtbidder-public-bids.html' }
    };
  }
};

// Oct 13 2026 — approved by the owner: bring-a-customer offer. The OPERATOR's fee is waived on the first job a
// contractor brings in (owner flips "No operator fee on this job" in Admin → All Bids). The client's fee still applies.
const NO_FEE_OFFER = {
  key: 'operators-no-fee-offer-2026-10-13',
  ownerCopy: 'daniel@dirtbidder.com',
  recipients: BRING_CUSTOMERS.recipients,
  content: name => {
    const first = String(name || '').trim().split(/\s+/)[0];
    return {
      subject: 'Bring us a customer, skip your DirtBidder fee',
      heading: 'Bring a customer, keep your full bid',
      orgLine: 'DirtBidder LLC · Iowa',
      lines: [
        `Hi${first ? ' ' + first : ''},`,
        'Daniel here from DirtBidder. Here’s an offer for our founding operators.',
        'Bring one of your own customers to DirtBidder, and you pay no DirtBidder fee on that job. You keep your full bid.',
        'HOW IT WORKS',
        '1. Have your customer post their job free at dirtbidder.com. Ponds, tile, driveways, building pads, anything.',
        '2. Email support@dirtbidder.com with your company name and the job title.',
        '3. Bid on it like normal. When they hire you, you get 100% of your bid.',
        'WHY IT’S EASIER THAN DOING IT THE OLD WAY',
        '• No chasing money. The customer’s payment is held before you start, and it’s sent to your bank when the job’s done. No invoices, no bounced checks, no waiting 60 days.',
        '• No driving around guessing. The customer drops a GPS pin, and you tap Get Directions straight to the spot.',
        '• Everything in one place. Questions, photos, changes and payment are all on your phone, not scattered across texts and voicemails.',
        '• Paperwork done for you. Your earnings are tracked for tax time.',
        '• Reviews that bring more work. Every finished job builds your rating, and 4 or 5 stars gets your company a free shoutout on our Facebook page.',
        'Good for the first job you bring in, through December 31.',
        'Thanks for being one of the first on DirtBidder.',
        '— Daniel Wheeler, Founder of DirtBidder',
        'If you’d rather not get emails like this, reply and let me know.'
      ],
      button: { label: 'Go to DirtBidder', url: 'https://www.dirtbidder.com' }
    };
  }
};

// Oct 14 2026 7:00 AM Central — approved by the owner: tell every contractor about getting paid in stages.
const STAGE_PAY = {
  key: 'operators-stage-pay-2026-10-14',
  ownerCopy: 'daniel@dirtbidder.com',
  recipients: BRING_CUSTOMERS.recipients,
  content: name => {
    const first = String(name || '').trim().split(/\s+/)[0];
    return {
      subject: 'New: get paid as you go on DirtBidder jobs',
      heading: 'Get paid as you go',
      orgLine: 'DirtBidder LLC · Iowa',
      lines: [
        `Hi${first ? ' ' + first : ''},`,
        'Daniel here from DirtBidder. Customers can now pay for a job in parts instead of all at once. That means you can get paid partway through a job instead of waiting until the end.',
        'HERE’S AN EXAMPLE',
        'Say you win a $6,000 pond job and the customer picks “pay in stages”:',
        '1. The customer pays $3,000 before you start. You get an email, and your dashboard shows it’s paid.',
        '2. You do the first half of the job and tap “Stage done” on your dashboard.',
        '3. The customer releases it, and $2,850 goes to your bank (the $3,000 minus DirtBidder’s fee). If they don’t do anything for 72 hours, it’s sent to you automatically.',
        '4. The customer pays the next $3,000. You get another email saying it’s paid.',
        '5. You finish the job and tap “Mark Job Complete.” The last part goes to your bank the same way.',
        'THE ONE RULE',
        'Don’t start the next part of a job until your dashboard says it’s paid. That way the money is always there before you do the work.',
        'Some customers will still pay the whole job up front. Your “You’re hired” email tells you which way they picked, so you’ll always know.',
        'Questions? Just reply to this email.',
        '— Daniel Wheeler, Founder of DirtBidder',
        'If you’d rather not get emails like this, reply and let me know.'
      ],
      button: { label: 'Open My Dashboard', url: 'https://www.dirtbidder.com/dirtbidder-operator-dashboard.html' }
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
  // Owner asked for this one to go out at 7:00 AM Central on Oct 12 2026
  const at = Date.parse('2026-10-12T12:00:00Z'), now = Date.now();
  setTimeout(() => send(pool, PUBLIC_BID_BOARD).catch(err => console.error('Broadcast error:', err.message)), Math.max(0, at - now));
  await send(pool, NO_FEE_OFFER);
  // Owner asked for this one to go out at 7:00 AM Central on Oct 14 2026
  const stageAt = Date.parse('2026-10-14T12:00:00Z');
  setTimeout(() => send(pool, STAGE_PAY).catch(err => console.error('Broadcast error:', err.message)), Math.max(0, stageAt - Date.now()));
}

module.exports = { migrate, send, runPending, BRING_CUSTOMERS, PUBLIC_BID_BOARD, NO_FEE_OFFER, STAGE_PAY };
