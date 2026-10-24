// The payment processing cost Stripe actually charged on a payment (Terms sections 11 and 12).
// Stripe doesn't give its fee back when a payment is refunded, so a refund is the amount paid minus this.
// Returns dollars. If Stripe can't tell us the fee, returns 0 and the client gets the full amount back.
async function processingCost(stripe, paymentIntentId) {
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge.balance_transaction'] });
    const bt = pi && pi.latest_charge && pi.latest_charge.balance_transaction;
    const fee = bt && typeof bt === 'object' ? Number(bt.fee) : 0;
    return fee > 0 ? Math.round(fee) / 100 : 0;
  } catch (e) {
    console.error('processing cost lookup:', e.message);
    return 0;
  }
}

// Amount to refund in cents: what we'd refund minus its share of the processing cost, never below zero
function refundCents(refundDollars, costDollars, shareOfPayment) {
  const share = Math.max(0, Math.min(1, shareOfPayment == null ? 1 : shareOfPayment));
  return Math.max(0, Math.round((Number(refundDollars) - Number(costDollars) * share) * 100));
}

module.exports = { processingCost, refundCents };
