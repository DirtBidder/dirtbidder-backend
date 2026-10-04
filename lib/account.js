// Is this operator account ready to deal with clients (bid, or message before being hired)?
// They need a name on file and a confirmed email, so a client never gets a bid from "nobody" at an address that doesn't work.
// Test accounts (+test / +op emails) are exempt: they only ever see test jobs.
const TEST_ACCT = /\+(test|op)\d*@/i;

async function operatorNotReady(pool, userId) {
  const r = await pool.query('SELECT email, name, company_name, email_confirmed_at FROM users WHERE id = $1', [userId]);
  const u = r.rows[0];
  if (!u) return 'Account not found';
  if (TEST_ACCT.test(u.email || '')) return null;
  if (!String(u.name || '').trim() && !String(u.company_name || '').trim())
    return 'Add your name first. Open Settings on your dashboard, fill in your name and company, and try again.';
  if (!u.email_confirmed_at)
    return 'Confirm your email first. Tap “Resend the link” in the box at the top of your dashboard, then tap the link in the email we send you.';
  return null;
}

module.exports = { operatorNotReady };
