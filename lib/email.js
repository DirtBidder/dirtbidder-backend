// Sends email through Resend (https://resend.com). If RESEND_API_KEY isn't set, emails are logged and skipped.
const FROM = process.env.EMAIL_FROM || 'DirtBidder <notifications@dirtbidder.com>';
const REPLY_TO = process.env.EMAIL_REPLY_TO || 'daniel@dirtbidder.com';
const SITE = process.env.FRONTEND_URL || 'https://www.dirtbidder.com';

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Simple branded layout: heading, paragraphs (plain text, escaped), optional button
function layout({ heading, lines = [], button }) {
  const body = lines.map(l => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#3D2B1F">${esc(l)}</p>`).join('');
  const btn = button ? `<p style="margin:22px 0 6px"><a href="${esc(button.url)}" style="display:inline-block;background:#E8892A;color:#1C1410;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:4px;font-family:Arial,sans-serif;letter-spacing:.5px">${esc(button.label)}</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#F2EDE6;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F2EDE6;padding:24px 12px"><tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:6px;overflow:hidden">
      <tr><td style="background:#1C1410;padding:16px 22px;font-size:22px;font-weight:900;color:#F2EDE6"><span style="color:#E8892A">Dirt</span>Bidder</td></tr>
      <tr><td style="padding:24px 22px">
        <h1 style="margin:0 0 16px;font-size:20px;color:#1C1410">${esc(heading)}</h1>
        ${body}${btn}
      </td></tr>
      <tr><td style="padding:14px 22px;background:#F7F3EE;font-size:12px;color:#8C7B6B">DirtBidder LLC · Gilmore City, Iowa · <a href="${SITE}" style="color:#8C7B6B">dirtbidder.com</a><br>Questions? Just reply to this email.</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function textVersion({ heading, lines = [], button }) {
  return [heading, '', ...lines, button ? `\n${button.label}: ${button.url}` : '', '\n— DirtBidder · dirtbidder.com'].join('\n');
}

async function sendEmail(to, content) {
  if (!to) return;
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log('[email skipped: no RESEND_API_KEY]', to, '-', content.subject); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject: content.subject, html: layout(content), text: textVersion(content) })
    });
    if (!res.ok) console.error('Email failed', res.status, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

module.exports = { sendEmail, SITE };
