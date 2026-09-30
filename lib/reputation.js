// Operator reputation: average star rating, completed jobs, and the badge they've earned.
// Badges are automatic — nobody can buy or set them.
const LEVELS = [
  { key: 'top', label: 'Top Operator', icon: '🥇', jobs: 40, rating: 4.8, noLostDisputes: true },
  { key: 'pro', label: 'Pro Operator', icon: '🥈', jobs: 15, rating: 4.5 },
  { key: 'proven', label: 'Proven', icon: '🥉', jobs: 5 }
];

function badgeFor(r) {
  for (const l of LEVELS) {
    if (r.jobs < l.jobs) continue;
    if (l.rating && (r.review_count === 0 || r.rating < l.rating)) continue;
    if (l.noLostDisputes && r.lost_disputes > 0) continue;
    return { key: l.key, label: l.label, icon: l.icon };
  }
  return null;
}

// What the operator needs for the next badge up (shown on their own Reviews page)
function nextBadge(r) {
  const cur = r.badge ? LEVELS.findIndex(l => l.key === r.badge.key) : LEVELS.length;
  if (cur <= 0) return null;
  const l = LEVELS[cur - 1];
  const need = [];
  if (r.jobs < l.jobs) need.push(`${l.jobs - r.jobs} more completed job${l.jobs - r.jobs === 1 ? '' : 's'}`);
  if (l.rating && (r.review_count === 0 || r.rating < l.rating)) need.push(`a ${l.rating}★ average or higher`);
  if (l.noLostDisputes && r.lost_disputes > 0) need.push('no lost disputes');
  return { label: l.label, icon: l.icon, need };
}

// Returns { [operatorId]: { rating, review_count, jobs, lost_disputes, verified, badge } }
async function getReputation(pool, operatorIds) {
  const ids = [...new Set((operatorIds || []).map(Number).filter(Boolean))];
  const out = {};
  if (!ids.length) return out;
  const r = await pool.query(
    `SELECT u.id,
       u.stripe_account_id IS NOT NULL AS verified,
       (SELECT ROUND(AVG(rv.rating)::numeric, 1) FROM reviews rv WHERE rv.reviewee_id = u.id) AS rating,
       (SELECT COUNT(*) FROM reviews rv WHERE rv.reviewee_id = u.id)::int AS review_count,
       (SELECT COUNT(*) FROM bids b JOIN jobs j ON j.id = b.job_id
          WHERE b.operator_id = u.id AND b.status = 'accepted' AND j.status = 'completed')::int AS jobs,
       (SELECT COUNT(*) FROM disputes d JOIN bids b ON b.job_id = d.job_id AND b.status = 'accepted'
          WHERE b.operator_id = u.id AND d.resolution = 'refund')::int AS lost_disputes
     FROM users u WHERE u.id = ANY($1::int[])`, [ids]);
  for (const row of r.rows) {
    row.rating = row.rating == null ? null : Number(row.rating);
    row.badge = badgeFor(row);
    out[row.id] = row;
  }
  return out;
}

module.exports = { getReputation, nextBadge, LEVELS };
