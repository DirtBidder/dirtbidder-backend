// Operator payout accounts (Stripe Connect Express)
const express = require('express');
const router = express.Router();
const { stripe, FRONTEND_URL } = require('../lib/stripe');
const { payPendingPayouts } = require('../lib/payouts');

module.exports = (pool, authMiddleware) => {
  function operatorsOnly(req, res, next) {
    if (req.user.role !== 'operator') return res.status(403).json({ error: 'Only operator accounts get payouts' });
    if (!stripe) return res.status(503).json({ error: 'Payments are not set up yet' });
    next();
  }

  // Start (or continue) payout setup: returns a Stripe-hosted link where the operator adds their bank
  router.post('/onboard', authMiddleware, operatorsOnly, async (req, res) => {
    try {
      const u = await pool.query('SELECT email, stripe_account_id FROM users WHERE id = $1', [req.user.id]);
      let acctId = u.rows[0] && u.rows[0].stripe_account_id;
      if (!acctId) {
        const acct = await stripe.accounts.create({
          type: 'express',
          country: 'US',
          email: u.rows[0].email,
          capabilities: { transfers: { requested: true } },
          business_profile: { product_description: 'Earthwork and heavy equipment services booked through DirtBidder', mcc: '1771' },
          metadata: { dirtbidder_user_id: String(req.user.id) }
        });
        acctId = acct.id;
        await pool.query('UPDATE users SET stripe_account_id = $1 WHERE id = $2', [acctId, req.user.id]);
      }
      const link = await stripe.accountLinks.create({
        account: acctId,
        type: 'account_onboarding',
        refresh_url: FRONTEND_URL + '/dirtbidder-operator-dashboard.html?connect=refresh',
        return_url: FRONTEND_URL + '/dirtbidder-operator-dashboard.html?connect=return'
      });
      res.json({ url: link.url });
    } catch (err) {
      console.error('Connect onboarding error:', err.message);
      const msg = /signed up for Connect|platform/i.test(err.message)
        ? 'Operator payouts are not switched on in Stripe yet.'
        : 'Could not start payout setup. Please try again.';
      res.status(500).json({ error: msg });
    }
  });

  // Payout setup status; also sends any payouts that were waiting on this setup
  router.get('/status', authMiddleware, operatorsOnly, async (req, res) => {
    try {
      const u = await pool.query('SELECT stripe_account_id FROM users WHERE id = $1', [req.user.id]);
      const acctId = u.rows[0] && u.rows[0].stripe_account_id;
      if (!acctId) return res.json({ connected: false, payouts_enabled: false });
      const acct = await stripe.accounts.retrieve(acctId);
      const ready = !!(acct.capabilities && acct.capabilities.transfers === 'active');
      let sent = 0;
      if (ready) sent = (await payPendingPayouts(pool, req.user.id)).paid;
      res.json({
        connected: true,
        details_submitted: !!acct.details_submitted,
        payouts_enabled: ready && !!acct.payouts_enabled,
        transfers_active: ready,
        payouts_sent_now: sent
      });
    } catch (err) {
      console.error('Connect status error:', err.message);
      res.status(500).json({ error: 'Could not check payout setup' });
    }
  });

  // Link to the operator's Stripe Express dashboard (see payouts, update bank)
  router.post('/dashboard', authMiddleware, operatorsOnly, async (req, res) => {
    try {
      const u = await pool.query('SELECT stripe_account_id FROM users WHERE id = $1', [req.user.id]);
      const acctId = u.rows[0] && u.rows[0].stripe_account_id;
      if (!acctId) return res.status(400).json({ error: 'Set up payouts first' });
      const link = await stripe.accounts.createLoginLink(acctId);
      res.json({ url: link.url });
    } catch (err) {
      console.error('Connect dashboard error:', err.message);
      res.status(500).json({ error: 'Could not open your payout dashboard' });
    }
  });

  return router;
};
