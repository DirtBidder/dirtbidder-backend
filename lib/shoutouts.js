// Shoutouts: when a client rates a finished job 4 or 5 stars, DirtBidder can feature the operator's company on social media.
// The operator has to say OK first (profile.featureOk, with the date in profile.featureOkAt).
// A post names the company, the kind of job, the county and the stars. Never the client, the town, the address or the price.
// Nothing is posted automatically: the owner copies the ready-made post from the admin Shoutouts tab and posts it himself.
const MIN_STARS = 4;
const FACEBOOK_URL = process.env.FACEBOOK_URL || 'https://www.facebook.com/share/19SidpGE2d/';

const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'Washington, D.C.', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

// ZIP code -> county, from public Census data (lib/zip-counties.json). Loaded the first time it's needed.
let zips = null;
function countyOfZip(zip) {
  if (!zips) { try { zips = require('./zip-counties.json'); } catch (e) { zips = { c: [], z: {} }; } }
  const hit = zips.c[zips.z[zip]];
  if (!hit) return null;
  const [name, st] = hit.split('|');
  return { name, st };
}

// A job's public location looks like "Gilmore City, IA — 50541". Turn it into something safe to post:
// "Humboldt County, Iowa" when the ZIP is known, just "Iowa" when only the state is, or '' when neither is.
function areaFor(location) {
  const loc = String(location || '');
  const zip = (loc.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1];
  const c = zip ? countyOfZip(zip) : null;
  if (c && STATES[c.st]) {
    // Most places say "County". Louisiana parishes, Alaska boroughs and Virginia's independent cities already carry their own word.
    const named = /\b(Parish|Borough|Census Area|Municipality|city)$/i.test(c.name);
    const county = named ? c.name.replace(/\bcity$/, '').trim() : c.name + ' County';
    return county + ', ' + STATES[c.st];
  }
  const st = (loc.match(/,\s*([A-Za-z]{2})\b/) || [])[1];
  return (st && STATES[st.toUpperCase()]) || '';
}

// "Field Tile" -> "a field tile job". Unknown or "Other" -> "a dirt work job".
function jobPhrase(jobType) {
  let t = String(jobType || '').trim().toLowerCase();
  if (!t || t === 'other' || t.length > 60) t = 'dirt work';
  t = t.replace(/\s*\/\s*/g, ' and ');
  return (/^[aeiou]/.test(t) ? 'an ' : 'a ') + t + ' job';
}

// The ready-made post. "On time" is only said when the client said so in their review.
function postText(r) {
  const stars = '⭐'.repeat(r.rating);
  const area = areaFor(r.location);
  return [
    `${stars} Shoutout to ${r.company}!`,
    '',
    `They just finished ${jobPhrase(r.job_type)}${area ? ' in ' + area : ''} through DirtBidder and earned ${r.rating} stars from the client${r.on_time === true ? ', with the job done on time' : ''}.`,
    '',
    'Need dirt work done? Post your job free at dirtbidder.com and get bids from operators like this one.',
    '',
    'Remember: DirtBidder.com is where your money stays safe. A client’s payment is held until the job is done, and operators know the money is there before they start, so they don’t have to chase it.'
  ].join('\n');
}

// Every review that could earn a shoutout: 4+ stars on a paid-out job, no refund from a dispute, operator still in good standing.
// Test accounts and the owner's own accounts are marked (is_test) so they can be left out.
const TEST = a => `(${a}.email ~* '\\+(test|op)[0-9]*@' OR COALESCE(${a}.internal, false))`;
const SELECT = `
  SELECT rv.id, rv.rating, rv.on_time, rv.created_at, rv.shoutout_status, rv.shoutout_at, rv.shoutout_text, rv.shoutout_notified_at,
         j.id AS job_id, j.title AS job_title, j.job_type, j.location, j.completed_at,
         o.id AS operator_id, o.email AS operator_email,
         COALESCE(NULLIF(btrim(o.company_name), ''), NULLIF(btrim(o.name), '')) AS company,
         (o.profile->>'featureOk') = 'true' AS feature_ok, o.profile->>'featureOkAt' AS feature_ok_at,
         (o.profile->>'featureOk') = 'false' AS feature_declined,
         (${TEST('o')} OR ${TEST('c')} OR COALESCE(j.internal, false)) AS is_test
  FROM reviews rv
  JOIN jobs j ON j.id = rv.job_id
  JOIN users o ON o.id = rv.reviewee_id
  JOIN users c ON c.id = j.client_id
  WHERE rv.rating >= ${MIN_STARS} AND j.status = 'completed' AND o.suspended_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.job_id = j.id AND d.resolution IN ('refund', 'split'))`;

const withText = r => Object.assign(r, { area: areaFor(r.location), text: r.company ? postText(r) : null });

async function one(pool, reviewId) {
  const r = await pool.query(SELECT + ' AND rv.id = $1', [reviewId]);
  return r.rows[0] ? withText(r.rows[0]) : null;
}

// For the admin Shoutouts tab: ready to post, waiting on the operator's OK, and already posted.
async function list(pool, { withTest = false } = {}) {
  const r = await pool.query(SELECT + ' ORDER BY rv.created_at DESC LIMIT 300');
  const rows = r.rows.filter(x => withTest || !x.is_test).map(withText);
  return {
    ready: rows.filter(x => !x.shoutout_status && x.feature_ok && x.company),
    waiting: rows.filter(x => !x.shoutout_status && !(x.feature_ok && x.company)),
    posted: rows.filter(x => x.shoutout_status === 'posted'),
    skipped: rows.filter(x => x.shoutout_status === 'skipped').length
  };
}

// Tell the owner a post is ready, once per review. Called when a review comes in and when an operator turns shoutouts on.
async function announce(pool, row) {
  if (!row || row.is_test || row.shoutout_status || row.shoutout_notified_at || !row.feature_ok || !row.company) return false;
  const claim = await pool.query('UPDATE reviews SET shoutout_notified_at = NOW() WHERE id = $1 AND shoutout_notified_at IS NULL RETURNING id', [row.id]);
  if (!claim.rows.length) return false;
  require('./notify').shoutoutReady(pool, row.id);
  return true;
}

// Fire-and-forget hooks: a problem here never breaks the review or the settings save.
function onReview(pool, reviewId) {
  one(pool, reviewId).then(row => announce(pool, row)).catch(err => console.error('Shoutout check failed:', err.message));
}
function onOptIn(pool, operatorId) {
  pool.query(SELECT + ' AND o.id = $1 AND rv.shoutout_status IS NULL AND rv.shoutout_notified_at IS NULL ORDER BY rv.id', [operatorId])
    .then(async r => { for (const row of r.rows) await announce(pool, withText(row)); })
    .catch(err => console.error('Shoutout check failed:', err.message));
}

module.exports = { MIN_STARS, FACEBOOK_URL, areaFor, jobPhrase, postText, one, list, onReview, onOptIn };
