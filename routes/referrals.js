// Partner referrals (Refuge storm shelters first): a customer asks DirtBidder to send their info to a partner for a quote.
// Each request is saved with the date, so DirtBidder can prove the referral and track its 12-month credit window.
// The public form only works when REFERRALS_ON=1 is set in Railway (off until the referral agreement is signed).
// Partner emails only go out when that partner's address is set (e.g. PARTNER_REFUGE_EMAIL); otherwise only the owner is told.
const express = require('express');
const { sendEmail, SITE } = require('../lib/email');
const { VIEW_ONLY_MSG } = require('../lib/viewer');

const PARTNERS = {
  refuge: { name: 'Refuge Storm Shelters (Fiberglass Creations)', short: 'Refuge', emailVar: 'PARTNER_REFUGE_EMAIL' }
};
const STATUSES = ['open', 'quoted', 'bought', 'not_buying'];
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'daniel@dirtbidder.com').split(',').map(e => e.trim()).filter(Boolean);
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    partner VARCHAR(40) NOT NULL,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(160),
    phone VARCHAR(40),
    zip VARCHAR(10),
    town VARCHAR(120),
    product VARCHAR(120),
    notes TEXT,
    consent_text TEXT NOT NULL,
    consent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '12 months'),
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    quoted_at DATE,
    bought_at DATE,
    sale_amount NUMERIC(10,2),
    fee NUMERIC(10,2),
    fee_paid_at DATE,
    sent_to_partner BOOLEAN NOT NULL DEFAULT FALSE,
    owner_note TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS referrals_partner_idx ON referrals (partner, consent_at)');
}

// Does this referral earn the fee? Bought (or quoted / deposit made) within the 12-month window.
const counts = r => {
  const end = new Date(r.expires_at);
  return (r.quoted_at && new Date(r.quoted_at) <= end) || (r.bought_at && new Date(r.bought_at) <= end);
};

module.exports = (pool, authMiddleware, adminOnly) => {
  const router = express.Router();

  // Public: customer asks for their info to go to a partner
  router.post('/', async (req, res) => {
    try {
      if (process.env.REFERRALS_ON !== '1') return res.status(503).json({ error: 'Quote requests aren’t open yet. Please check back soon.' });
      const b = req.body || {};
      if (b.website) return res.json({ ok: true }); // bot trap
      const partner = PARTNERS[String(b.partner || '').toLowerCase()];
      if (!partner) return res.status(400).json({ error: 'Unknown partner' });
      const name = clean(b.name, 120), email = clean(b.email, 160).toLowerCase(), phone = clean(b.phone, 40), zip = clean(b.zip, 10);
      if (!name) return res.status(400).json({ error: 'Please enter your name' });
      if (!email && !phone) return res.status(400).json({ error: 'Please enter a phone number or email so they can reach you' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'That email doesn’t look right' });
      if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: 'Please enter your 5-digit ZIP code' });
      if (b.consent !== true) return res.status(400).json({ error: 'Please check the box to let us send your info' });
      // No more than 3 requests for the same partner from the same email/phone in a day
      const dup = await pool.query(`SELECT COUNT(*)::int AS n FROM referrals WHERE partner = $1 AND consent_at > NOW() - INTERVAL '1 day'
        AND ((email <> '' AND email = $2) OR (phone <> '' AND phone = $3))`, [String(b.partner).toLowerCase(), email, phone]);
      if (dup.rows[0].n >= 3) return res.json({ ok: true });
      let town = '';
      try { town = (await require('../lib/zipcity').lookup(zip)) || ''; } catch (e) { /* town is just a nicety */ }
      const consent = `I asked DirtBidder to send my name, contact details, ZIP code and the details I entered to ${partner.name} so they can contact me with a quote.`;
      const r = await pool.query(`INSERT INTO referrals (partner, name, email, phone, zip, town, product, notes, consent_text)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [String(b.partner).toLowerCase(), name, email, phone, zip, town, clean(b.product, 120), clean(b.notes, 1000), consent]);
      const ref = r.rows[0];
      const lines = [`Name: ${name}`, phone && `Phone: ${phone}`, email && `Email: ${email}`, `ZIP: ${zip}${town ? ' (' + town + ')' : ''}`,
        ref.product && `Interested in: ${ref.product}`, ref.notes && `Notes: ${ref.notes}`].filter(Boolean);
      const partnerTo = process.env[partner.emailVar];
      if (partnerTo) {
        const sent = await sendEmail(partnerTo, {
          subject: `New quote request from DirtBidder: ${name} (${zip})`,
          heading: 'A customer asked for a quote',
          lines: [...lines, `DirtBidder referral #${ref.id}, sent ${new Date(ref.consent_at).toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}. The customer asked us to send you their info.`]
        });
        if (sent) await pool.query('UPDATE referrals SET sent_to_partner = TRUE WHERE id = $1', [ref.id]);
      }
      for (const to of ADMIN_EMAILS) await sendEmail(to, {
        subject: `New ${partner.short} referral #${ref.id}: ${name}`,
        heading: `New ${partner.short} referral`,
        lines: [...lines, partnerTo ? `Sent to ${partner.short}.` : `Not sent to ${partner.short} automatically (no partner email set). Forward it yourself.`,
          `Credit runs until ${new Date(ref.expires_at).toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}.`],
        button: { label: 'Open HQ', url: SITE + '/dirtbidder-hq.html' }
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('Referral error:', err);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  // Owner: list referrals, totals, and shelter installs per month
  router.get('/admin', authMiddleware, adminOnly, async (req, res) => {
    try {
      const viewer = !!req.user.viewer;
      const rows = viewer ? [] : (await pool.query('SELECT * FROM referrals ORDER BY consent_at DESC LIMIT 500')).rows;
      const installs = (await pool.query(`SELECT to_char(date_trunc('month', (created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago'), 'YYYY-MM') AS month, COUNT(*)::int AS n
        FROM jobs WHERE job_type ILIKE '%shelter%' AND status <> 'test' AND created_at > NOW() - INTERVAL '13 months'
        GROUP BY 1 ORDER BY 1`)).rows;
      const now = Date.now();
      const list = rows.map(r => ({ ...r, earns_fee: !!counts(r), active: new Date(r.expires_at).getTime() > now }));
      const totals = {
        all: list.length,
        open: list.filter(r => r.active && (r.status === 'open' || r.status === 'quoted')).length,
        bought: list.filter(r => r.status === 'bought').length,
        fees_owed: list.filter(r => r.status === 'bought' && r.earns_fee && !r.fee_paid_at).reduce((s, r) => s + Number(r.fee || 0), 0),
        fees_paid: list.filter(r => r.fee_paid_at).reduce((s, r) => s + Number(r.fee || 0), 0)
      };
      res.json({ referrals: list, totals, installs, on: process.env.REFERRALS_ON === '1' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Owner: update a referral (quoted / bought / not buying, sale amount, fee, fee paid)
  router.post('/admin/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
      if (req.user.viewer) return res.status(403).json({ error: VIEW_ONLY_MSG });
      const b = req.body || {};
      const day = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
      const num = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
      if (b.status && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'Bad status' });
      const r = await pool.query(`UPDATE referrals SET
          status = COALESCE($2, status),
          quoted_at = CASE WHEN $3::boolean THEN $4::date ELSE quoted_at END,
          bought_at = CASE WHEN $5::boolean THEN $6::date ELSE bought_at END,
          sale_amount = CASE WHEN $7::boolean THEN $8::numeric ELSE sale_amount END,
          fee = CASE WHEN $9::boolean THEN $10::numeric ELSE fee END,
          fee_paid_at = CASE WHEN $11::boolean THEN $12::date ELSE fee_paid_at END,
          owner_note = CASE WHEN $13::boolean THEN $14 ELSE owner_note END,
          updated_at = NOW()
        WHERE id = $1 RETURNING *`,
        [parseInt(req.params.id, 10), b.status || null,
          'quoted_at' in b, day(b.quoted_at), 'bought_at' in b, day(b.bought_at),
          'sale_amount' in b, num(b.sale_amount), 'fee' in b, num(b.fee),
          'fee_paid_at' in b, day(b.fee_paid_at), 'owner_note' in b, clean(b.owner_note, 500)]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
      res.json({ referral: { ...r.rows[0], earns_fee: !!counts(r.rows[0]) } });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
module.exports.migrate = migrate;
module.exports.counts = counts;
module.exports.money = money;
