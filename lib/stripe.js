// Stripe clients. Two modes can run side by side:
//   STRIPE_SECRET_KEY       — the main key (live once DirtBidder is approved; test before that)
//   STRIPE_TEST_SECRET_KEY  — a test key kept for test accounts (+test / +op emails) after going live
// Every payment remembers which mode it was made in (escrow_transactions.test_mode), so refunds and
// payouts for it always go through the same mode. Test accounts never touch real money.
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.dirtbidder.com';
const mainKey = process.env.STRIPE_SECRET_KEY || null;
const isTestMode = !!mainKey && mainKey.startsWith('sk_test_'); // main key is still a test key
const isLive = !!mainKey && mainKey.startsWith('sk_live_');
const testKey = process.env.STRIPE_TEST_SECRET_KEY || (isTestMode ? mainKey : null);

const main = mainKey ? require('stripe')(mainKey) : null;
const testClient = testKey ? (testKey === mainKey ? main : require('stripe')(testKey)) : null;

// Client and raw key for one mode: test = true for test accounts / test payments
const stripeFor = test => (test ? testClient : main);
const keyFor = test => (test ? testKey : mainKey);
// Test accounts are emails with "+test" or "+op" (e.g. dwheels7943+op2@gmail.com)
const isTestEmail = email => /\+(test|op)\d*@/i.test(String(email || ''));

module.exports = { stripe: main, stripeFor, keyFor, isTestEmail, isTestMode, isLive, FRONTEND_URL };
