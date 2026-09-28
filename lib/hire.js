// Marks a bid as hired: accepts it, declines the other bids, and starts the job.
async function hireBid(pool, bid) {
  await pool.query("UPDATE bids SET status = 'accepted' WHERE id = $1", [bid.id]);
  await pool.query("UPDATE bids SET status = 'declined' WHERE job_id = $1 AND id <> $2 AND status = 'pending'", [bid.job_id, bid.id]);
  await pool.query("UPDATE jobs SET status = 'in_progress', hired_at = NOW() WHERE id = $1", [bid.job_id]);
}

module.exports = { hireBid };
