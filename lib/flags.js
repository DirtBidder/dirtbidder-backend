// Catching attempts to take jobs off DirtBidder (to skip the fee and escrow).
// 1) scanText: hides phone numbers / emails / links in bids, job posts and profiles, and spots "pay me direct" wording
// 2) addFlag: puts it on the admin's Flagged list and emails the admin
const HIDDEN = '[contact info hidden — shared after hiring]';

const PHONE = /(?:\+?1[\s.\-]?)?\(?\b\d{3}\)?[\s.\-]{0,3}\d{3}[\s.\-]{0,3}\d{4}\b/g;
const EMAIL = /[A-Z0-9._%+\-]+\s*(?:@|\(at\)|\[at\])\s*[A-Z0-9.\-]+\s*(?:\.|\(dot\)|\[dot\])\s*[A-Z]{2,}/gi;
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9\-]+\.(?:com|net|org|biz|us|co)\b(?:\/\S*)?/gi;
const WORDS = [
  [/\bcash\b/i, 'mentions cash'],
  [/\bvenmo\b/i, 'mentions Venmo'],
  [/\bzelle\b/i, 'mentions Zelle'],
  [/\bcash\s?app\b/i, 'mentions Cash App'],
  [/\bpaypal\b/i, 'mentions PayPal'],
  [/\b(?:personal\s+)?checks?\b.*\bpay|\bpay\b.*\bchecks?\b/i, 'mentions paying by check'],
  [/\b(?:pay|paying)\s+(?:me\s+)?(?:direct(?:ly)?|in person|on site|at the site)\b/i, 'asks to be paid directly'],
  [/\b(?:off|outside|around|skip|avoid)\s+(?:of\s+)?(?:the\s+)?(?:app|site|website|platform|dirt\s?bidder|fees?)\b/i, 'talks about going around DirtBidder'],
  [/\b(?:call|text|email|message|contact)\s+me\b/i, 'asks to be contacted directly'],
  [/\bno\s+fees?\b|\bsave\s+(?:on\s+)?(?:the\s+)?fees?\b/i, 'talks about avoiding the fee']
];

// Returns { text (with contact info hidden), reasons: [] }
function scanText(input) {
  let text = String(input || '');
  const reasons = [];
  if (!text.trim()) return { text: input, reasons };
  const hide = (re, label) => {
    const before = text;
    text = text.replace(re, HIDDEN);
    if (text !== before && !reasons.includes(label)) reasons.push(label);
  };
  hide(EMAIL, 'included an email address');
  hide(PHONE, 'included a phone number');
  hide(LINK, 'included a website or link');
  for (const [re, label] of WORDS) if (re.test(input)) reasons.push(label);
  return { text, reasons };
}

// Scan several fields at once: returns { cleaned: {field: text}, reasons, original: 'field: text\n...' }
function scanFields(fields) {
  const cleaned = {}, reasons = [], orig = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') { cleaned[k] = v; continue; }
    const r = scanText(v);
    cleaned[k] = r.text;
    if (r.reasons.length) { r.reasons.forEach(x => { if (!reasons.includes(x)) reasons.push(x); }); orig.push(`${k}: ${v}`); }
  }
  return { cleaned, reasons, original: orig.join('\n') };
}

// kind: 'bid' | 'job' | 'profile' | 'report' | 'pattern'
async function addFlag(pool, { kind, userId, reporterId = null, jobId = null, bidId = null, reason, details = null }) {
  try {
    // Don't pile up duplicates: one open flag per user + kind + job
    const dup = await pool.query(
      "SELECT id FROM flags WHERE status = 'open' AND kind = $1 AND user_id = $2 AND COALESCE(job_id, 0) = COALESCE($3::int, 0) AND COALESCE(reporter_id, 0) = COALESCE($4::int, 0)",
      [kind, userId, jobId, reporterId]);
    if (dup.rows.length) {
      await pool.query('UPDATE flags SET reason = $1, details = COALESCE($2, details), created_at = NOW() WHERE id = $3', [reason, details, dup.rows[0].id]);
      return dup.rows[0].id;
    }
    const r = await pool.query(
      'INSERT INTO flags (kind, user_id, reporter_id, job_id, bid_id, reason, details) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [kind, userId, reporterId, jobId, bidId, reason, details]);
    require('./notify').adminFlag(pool, r.rows[0].id);
    return r.rows[0].id;
  } catch (err) {
    console.error('addFlag failed:', err.message);
  }
}

// A client who keeps closing jobs right after getting bids may be taking the deals off the site
async function checkClosePattern(pool, clientId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM jobs j
     WHERE j.client_id = $1 AND j.status = 'closed' AND j.created_at > NOW() - INTERVAL '90 days'
       AND EXISTS (SELECT 1 FROM bids b WHERE b.job_id = j.id)`, [clientId]);
  const n = r.rows[0].n;
  if (n >= 2) {
    await addFlag(pool, { kind: 'pattern', userId: clientId,
      reason: `Closed ${n} jobs in the last 90 days after getting bids, without hiring through DirtBidder. They may be hiring the operators directly.` });
  }
}

module.exports = { scanText, scanFields, addFlag, checkClosePattern, HIDDEN };
