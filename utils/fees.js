// DirtBidder platform fee, charged to EACH side (client and operator).
// Bracket style, like tax brackets: each rate applies only to the part of the job inside its range.
//   First $10,000: 5% | $10,000–$100,000: 3% | $100,000–$500,000: 2% | over $500,000: 1% (default; big jobs are negotiated)
const BRACKETS = [
  [10000, 0.05],
  [100000, 0.03],
  [500000, 0.02],
  [Infinity, 0.01]
];

function feePerSide(amount) {
  const a = Number(amount) || 0;
  let fee = 0, lower = 0;
  for (const [upper, rate] of BRACKETS) {
    if (a > lower) fee += (Math.min(a, upper) - lower) * rate;
    lower = upper;
  }
  return Math.round(fee * 100) / 100;
}

// Client pays job + fee; operator receives job - fee; DirtBidder keeps both fees.
function breakdown(amount) {
  const a = Number(amount) || 0;
  const fee = feePerSide(a);
  return { job_amount: a, client_fee: fee, operator_fee: fee, client_total: a + fee, operator_payout: a - fee, platform_revenue: fee * 2 };
}

module.exports = { BRACKETS, feePerSide, breakdown };
