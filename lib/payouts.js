// Sends released escrow money to operators' own Stripe (Connect) accounts.
const { stripe } = require('./stripe');
const v2 = require('./stripeV2');

// Try to pay every released-but-unpaid escrow for one operator (or all operators when operatorId is null).
async function payPendingPayouts(pool, operatorId = null) {
  if (!stripe) return { paid: 0 };
  const r = await pool.query(
    `SELECT e.id, e.job_id, e.operator_payout, e.stripe_payment_intent_id, u.id AS operator_id, u.stripe_account_id
     FROM escrow_transactions e
     JOIN bids b ON b.id = e.bid_id
     JOIN users u ON u.id = b.operator_id
     WHERE e.status = 'released' AND e.stripe_transfer_id IS NULL
       AND u.stripe_account_id IS NOT NULL
       AND ($1::int IS NULL OR u.id = $1)`,
    [operatorId]
  );
  let paid = 0;
  const readyCache = {};
  for (const e of r.rows) {
    try {
      if (readyCache[e.stripe_account_id] === undefined) {
        const acct = await v2.getAccount(e.stripe_account_id);
        readyCache[e.stripe_account_id] = v2.transfersStatus(acct) === 'active';
      }
      if (!readyCache[e.stripe_account_id]) continue;

      // Tie the transfer to the client's original charge so it goes out as soon as that charge settles
      let sourceCharge;
      if (e.stripe_payment_intent_id) {
        const pi = await stripe.paymentIntents.retrieve(e.stripe_payment_intent_id);
        sourceCharge = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge && pi.latest_charge.id;
      }
      const transfer = await stripe.transfers.create({
        amount: Math.round(Number(e.operator_payout) * 100),
        currency: 'usd',
        destination: e.stripe_account_id,
        ...(sourceCharge ? { source_transaction: sourceCharge } : {}),
        metadata: { escrow_id: String(e.id), job_id: String(e.job_id) }
      }, { idempotencyKey: 'escrow-payout-' + e.id });
      await pool.query('UPDATE escrow_transactions SET stripe_transfer_id = $1, paid_out_at = NOW() WHERE id = $2', [transfer.id, e.id]);
      paid++;
    } catch (err) {
      console.error('Payout failed for escrow', e.id, '-', err.message);
    }
  }
  return { paid };
}

module.exports = { payPendingPayouts };
