// Forgot password / reset password
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sendEmail, SITE } = require('../lib/email');

const hash = t => crypto.createHash('sha256').update(t).digest('hex');

module.exports = (pool) => {
  // Always answers the same way so nobody can use this to check which emails have accounts
  router.post('/forgot', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    res.json({ ok: true });
    if (!email.includes('@')) return;
    try {
      const u = await pool.query('SELECT id, email, name FROM users WHERE lower(email) = $1', [email]);
      if (!u.rows[0]) { console.log('[forgot] no account for', email); return; }
      const recent = await pool.query("SELECT COUNT(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'", [u.rows[0].id]);
      if (recent.rows[0].n >= 3) { console.log('[forgot] rate limited', email); return; }
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')", [u.rows[0].id, hash(token)]);
      await sendEmail(u.rows[0].email, {
        subject: 'Reset your DirtBidder password',
        heading: 'Reset your password',
        lines: [`Hi ${(u.rows[0].name || '').split(' ')[0] || 'there'}, someone (hopefully you) asked to reset your DirtBidder password.`, 'This link works for 1 hour. If you didn’t ask for this, you can ignore this email — your password won’t change.'],
        button: { label: 'Choose a New Password', url: SITE + '/dirtbidder-reset-password.html?token=' + token }
      });
    } catch (err) { console.error('Forgot password error:', err.message); }
  });

  router.post('/reset', async (req, res) => {
    try {
      const token = String(req.body.token || '');
      const password = String(req.body.password || '');
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      const r = await pool.query(
        'SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()', [hash(token)]);
      if (!r.rows[0]) return res.status(400).json({ error: 'This reset link is invalid or expired. Request a new one.' });
      const pw = await bcrypt.hash(password, 10);
      // Getting here means they opened a link we emailed them, so the address works
      await pool.query('UPDATE users SET password_hash = $1, email_confirmed_at = COALESCE(email_confirmed_at, NOW()) WHERE id = $2', [pw, r.rows[0].user_id]);
      await pool.query('UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [r.rows[0].user_id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('Reset password error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
};
