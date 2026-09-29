// Minimal client for Stripe's v2 Accounts API (connected operator accounts).
const KEY = process.env.STRIPE_SECRET_KEY;
const VERSION = '2026-08-26.dahlia';

async function v2(method, path, body) {
  const res = await fetch('https://api.stripe.com' + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + KEY,
      'Stripe-Version': VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data && data.error) || {};
    const err = new Error(e.message || ('Stripe v2 error ' + res.status));
    err.code = e.code;
    throw err;
  }
  return data;
}

// Operator account that can receive transfers from DirtBidder, with the Express dashboard
function createRecipientAccount({ email, name, userId }) {
  return v2('POST', '/v2/core/accounts', {
    contact_email: email,
    display_name: name || undefined,
    identity: { country: 'us' },
    dashboard: 'express',
    defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    metadata: { dirtbidder_user_id: String(userId) },
    include: ['configuration.recipient']
  });
}

function getAccount(id) {
  return v2('GET', '/v2/core/accounts/' + encodeURIComponent(id) + '?include[0]=configuration.recipient&include[1]=requirements');
}

function transfersStatus(acct) {
  const c = acct && acct.configuration && acct.configuration.recipient;
  const t = c && c.capabilities && c.capabilities.stripe_balance && c.capabilities.stripe_balance.stripe_transfers;
  return (t && t.status) || 'unknown';
}

function createOnboardingLink(accountId, returnUrl, refreshUrl) {
  return v2('POST', '/v2/core/account_links', {
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: { configurations: ['recipient'], return_url: returnUrl, refresh_url: refreshUrl }
    }
  });
}

module.exports = { createRecipientAccount, getAccount, transfersStatus, createOnboardingLink };
