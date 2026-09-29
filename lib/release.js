// Releasing escrow to the operator (used by the client's Release button, auto-release, and admin decisions)
const { payPendingPayouts } = require('./payouts');

async function releaseJob(pool, jobId) {
  await pool.query("UPDATE escrow_transactions SET status = 'released', released_at = NOW() WHERE job_id = $1 AND status IN ('held', 'disputed')", [jobId]);
  await pool.query("UPDATE jobs SET status = 'completed', completed_at = COALESCE(completed_at, NOW()) WHERE id = $1", [jobId]);
  const op = await pool.query("SELECT operator_id FROM bids WHERE job_id = $1 AND status = 'accepted' LIMIT 1", [jobId]);
  if (op.rows[0]) await payPendingPayouts(pool, op.rows[0].operator_id);
  require('./notify').released(pool, jobId);
}

// Jobs the operator marked done more than 72 hours ago, with no dispute, release automatically
const AUTO_RELEASE_HOURS = 72;
async function autoReleaseDueJobs(pool) {
  const due = await pool.query(
    `SELECT j.id FROM jobs j
     WHERE j.status = 'awaiting_release' AND j.completed_at < NOW() - INTERVAL '${AUTO_RELEASE_HOURS} hours'
       AND EXISTS (SELECT 1 FROM escrow_transactions e WHERE e.job_id = j.id AND e.status = 'held')`
  );
  for (const row of due.rows) {
    try { await releaseJob(pool, row.id); console.log('Auto-released job', row.id); }
    catch (err) { console.error('Auto-release failed for job', row.id, '-', err.message); }
  }
}

module.exports = { releaseJob, autoReleaseDueJobs, AUTO_RELEASE_HOURS };
