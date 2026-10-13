// Paying for a job in stages. The client picks one of three plans when they hire:
//   full         Pay everything now. It's all released to the operator when the job is done (the original way).
//   full_staged  Pay everything now, but it's released to the operator one stage at a time as the work gets done.
//   stages       Pay one stage at a time. Each stage is paid (and held) before the operator starts it,
//                and released when that stage is done.
// Each stage is its own escrow_transactions row (stage_n = 1..stage_count). With full_staged the rows share the
// one Stripe payment; with stages each row is its own payment. Change orders stay as their own rows (stage_n NULL)
// and are released with the last stage.
// Fees are the normal bracket fee on the whole bid, shared across the stages in proportion (last stage takes the rounding).
const { breakdown } = require('../utils/fees');

const PLANS = ['full', 'full_staged', 'stages'];
const MIN_STAGED = 2000;         // jobs under this are paid in full (splitting a tiny job isn't worth it)
const THREE_STAGES_FROM = 10000; // 2 stages under $10,000, 3 stages from $10,000

// Percent of the job in each stage
function stagePercents(amount) {
  return Number(amount) >= THREE_STAGES_FROM ? [34, 33, 33] : [50, 50];
}

const r2 = n => Math.round(n * 100) / 100;

// The money in each stage: [{ n, pct, amount, client_fee, operator_fee, client_total, operator_payout }]
function stageAmounts(amount, { noOperatorFee = false } = {}) {
  const f = breakdown(amount, { noOperatorFee });
  const pcts = stagePercents(amount);
  const out = [];
  let left = { amount: f.job_amount, client_fee: f.client_fee, operator_fee: f.operator_fee };
  pcts.forEach((pct, i) => {
    const last = i === pcts.length - 1;
    const part = k => last ? r2(left[k]) : r2(f[k === 'amount' ? 'job_amount' : k] * pct / 100);
    const s = { n: i + 1, pct, amount: part('amount'), client_fee: part('client_fee'), operator_fee: part('operator_fee') };
    left = { amount: left.amount - s.amount, client_fee: left.client_fee - s.client_fee, operator_fee: left.operator_fee - s.operator_fee };
    s.client_total = r2(s.amount + s.client_fee);
    s.operator_payout = r2(s.amount - s.operator_fee);
    out.push(s);
  });
  return out;
}

// What the client sees before choosing: every plan with its amounts
function planOptions(amount, opts = {}) {
  const full = breakdown(amount, opts);
  const staged = Number(amount) >= MIN_STAGED;
  return {
    staged_available: staged,
    full: { client_total: r2(full.client_total) },
    stages: staged ? stageAmounts(amount, opts) : []
  };
}

async function migrate(pool) {
  await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pay_plan VARCHAR(20)');
  await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS stage_count INTEGER');
  await pool.query('ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS pay_plan VARCHAR(20)');
  await pool.query('ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS stage_n INTEGER');
  await pool.query('ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS stage_count INTEGER');
  await pool.query('ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS stage_done_at TIMESTAMP'); // operator says this stage is done
}

// The hire payment cleared (held). Record the plan on the job, and for full_staged split the one payment into stage rows.
async function applyPlanOnFunding(pool, e) {
  const plan = PLANS.includes(e.pay_plan) ? e.pay_plan : 'full';
  if (plan === 'full') return;
  const job = (await pool.query('SELECT COALESCE(no_operator_fee, false) AS no_op FROM jobs WHERE id = $1', [e.job_id])).rows[0] || {};
  const bid = (await pool.query('SELECT amount FROM bids WHERE id = $1', [e.bid_id])).rows[0];
  if (!bid) return;
  const stages = stageAmounts(bid.amount, { noOperatorFee: !!job.no_op });
  await pool.query('UPDATE jobs SET pay_plan = $1, stage_count = $2 WHERE id = $3', [plan, stages.length, e.job_id]);
  if (plan === 'stages') return; // this row already is stage 1
  // full_staged: this row becomes stage 1, the rest become rows held on the same payment.
  // Only split once (a second confirm for the same payment does nothing).
  const fresh = (await pool.query('SELECT * FROM escrow_transactions WHERE id = $1', [e.id])).rows[0];
  if (!fresh || fresh.stage_n) return;
  const s1 = stages[0];
  const split = await pool.query(
    `UPDATE escrow_transactions SET stage_n = 1, stage_count = $1, amount = $2, client_fee = $3, operator_fee = $4, client_total = $5, operator_payout = $6
     WHERE id = $7 AND stage_n IS NULL RETURNING id`,
    [stages.length, s1.amount, s1.client_fee, s1.operator_fee, s1.client_total, s1.operator_payout, e.id]);
  if (!split.rows.length) return;
  for (const s of stages.slice(1)) {
    await pool.query(
      `INSERT INTO escrow_transactions (job_id, bid_id, amount, client_fee, operator_fee, client_total, operator_payout, status,
         stripe_payment_intent_id, test_mode, pay_plan, stage_n, stage_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'full_staged', $11, $12, $13)`,
      [fresh.job_id, fresh.bid_id, s.amount, s.client_fee, s.operator_fee, s.client_total, s.operator_payout, fresh.status,
       fresh.stripe_payment_intent_id, fresh.test_mode, s.n, stages.length, fresh.created_at]);
  }
}

// Stages on a job, for the dashboards: one entry per stage with where its money is
async function stagesFor(pool, jobId) {
  const j = (await pool.query(
    `SELECT j.pay_plan, j.stage_count, j.status, COALESCE(j.no_operator_fee, false) AS no_op, b.amount AS bid_amount
     FROM jobs j LEFT JOIN bids b ON b.job_id = j.id AND b.status = 'accepted' WHERE j.id = $1`, [jobId])).rows[0];
  if (!j || !j.pay_plan || j.pay_plan === 'full' || !j.stage_count) return null;
  const planned = j.bid_amount ? stageAmounts(j.bid_amount, { noOperatorFee: j.no_op }) : [];
  const rows = (await pool.query(
    `SELECT id, stage_n, amount, client_total, operator_payout, status, stage_done_at, released_at
     FROM escrow_transactions WHERE job_id = $1 AND stage_n IS NOT NULL
       AND status NOT IN ('cancelled', 'failed', 'refund_needed')
     ORDER BY stage_n, id DESC`, [jobId])).rows;
  const out = [];
  for (let n = 1; n <= j.stage_count; n++) {
    const r = rows.find(x => x.stage_n === n);
    const p = planned[n - 1] || {};
    // 'pending_payment' = the client opened checkout but hasn't finished: still unpaid
    const paid = r && r.status !== 'pending_payment';
    out.push({ n, escrow_id: paid ? r.id : null, status: paid ? r.status : 'unpaid',
      amount: paid ? Number(r.amount) : p.amount, client_total: paid ? Number(r.client_total) : p.client_total,
      operator_payout: paid ? Number(r.operator_payout) : p.operator_payout,
      done_at: paid ? r.stage_done_at : null, released_at: paid ? r.released_at : null });
  }
  return { job_id: Number(jobId), plan: j.pay_plan, count: j.stage_count, job_status: j.status, stages: out };
}

module.exports = { PLANS, MIN_STAGED, THREE_STAGES_FROM, stagePercents, stageAmounts, planOptions, migrate, applyPlanOnFunding, stagesFor };
