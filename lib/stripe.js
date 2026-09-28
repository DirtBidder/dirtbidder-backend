// Stripe client, or null when STRIPE_SECRET_KEY isn't set yet.
const key = process.env.STRIPE_SECRET_KEY;
const stripe = key ? require('stripe')(key) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.dirtbidder.com';
module.exports = { stripe, FRONTEND_URL, isTestMode: !!key && key.startsWith('sk_test_') };
