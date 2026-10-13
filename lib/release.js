// Releasing escrow to the operator (used by the client's Release button, auto-release, and admin decisions)
const { payPendingPayouts } = require('./payouts');

async function releaseJob(pool, jobId) {
  await pool.query("UPDATE escrow_transactions SET status = 'released', released_at = NOW() WHERE job_id = $1 AND status IN ('held', 'disputed')", [jobId]);
  await pool.query("UPDATE jobs SET status = 'completed', completed_at = COALESCE(completed_at, NOW()) WHERE id = $1", [jobId]);
  // Change requests nobody finished paying for are closed once the job is paid out
  await pool.query("UPDATE change_orders SET status = 'withdrawn', decided_at = NOW() WHERE job_id = $1 AND status IN ('pending', 'paying')", [jobId]).catch(() => {});
  await pool.query("UPDATE escrow_transactions SET status = 'cancelled' WHERE job_id = $1 AND status = 'pending_payment'", [jobId]);
  const op = await pool.query("SELECT operator_id FROM bids WHERE job_id = $1 AND status = 'accepted' LIMIT 1", [jobId]);
  if (op.rows[0]) await payPendingPayouts(pool, op.rows[0].operator_id);
  require('./notify').released(pool, jobId);
  require('./notify').askForReview(pool, jobId);
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
  // Stages (not the last one) the operator said were done more than 72 hours ago, with no dispute, release the same way
  const stages = await pool.query(
    `SELECT DISTINCT e.job_id, e.stage_n FROM escrow_transactions e JOIN jobs j ON j.id = e.job_id
     WHERE e.status = 'held' AND e.stage_n IS NOT NULL AND e.stage_n < COALESCE(e.stage_count, j.stage_count)
       AND e.stage_done_at < NOW() - INTERVAL '${AUTO_RELEASE_HOURS} hours' AND j.status IN ('in_progress', 'awaiting_release')`);
  for (const s of stages.rows) {
    try { await require('../routes/stages').releaseStage(pool, s.job_id, s.stage_n); console.log('Auto-released job', s.job_id, 'stage', s.stage_n); }
    catch (err) { console.error('Stage auto-release failed for job', s.job_id, 'stage', s.stage_n, '-', err.message); }
  }
}

module.exports = { releaseJob, autoReleaseDueJobs, AUTO_RELEASE_HOURS };
