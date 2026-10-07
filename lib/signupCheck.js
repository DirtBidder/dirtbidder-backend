// Turns away sign-ups that are plainly not a real person: a placeholder name ("Test Test"),
// a made-up phone number ((555) 000-0000) or a throwaway email service.
// The rules are kept narrow on purpose. A real customer must never be blocked, so anything
// merely unusual is let through and shows up in the owner's "new sign-up" email instead.

// Every word of the name has to be one of these for the name to be refused
const PLACEHOLDER_WORDS = new Set([
  'test', 'tests', 'testing', 'tester', 'asdf', 'asdfg', 'qwerty', 'abc', 'xyz', 'xxx',
  'fake', 'none', 'null', 'anon', 'anonymous', 'user', 'name', 'first', 'last', 'firstname', 'lastname', 'foo', 'bar'
]);

// Well-known throwaway email services. These services add new domains all the time, so this catches the common ones, not all.
const THROWAWAY_DOMAINS = new Set([
  'calirona.com', 'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com',
  'sharklasers.com', 'grr.la', '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'temp-mail.io',
  'tempmailo.com', 'tempail.com', 'yopmail.com', 'yopmail.net', 'trashmail.com', 'getnada.com', 'nada.email',
  'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'emailondeck.com', 'moakt.com', 'mohmal.com',
  'mintemail.com', 'mailnesia.com', 'spamgourmet.com', 'discard.email', 'example.com', 'example.org', 'test.com'
]);

const TEST_ACCOUNT = /\+(test|op)\d*@/i; // the owner's own test accounts

function placeholderName(name) {
  const words = String(name || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.length > 0 && words.every(w => PLACEHOLDER_WORDS.has(w));
}

function fakePhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length < 7) return false; // too short to judge here
  if (/^(\d)\1+$/.test(d)) return true; // 0000000000, 5555555555
  if (d === '1234567890' || d === '0123456789' || d === '9876543210' || d === '1234567') return true;
  if (d.length === 10 && d.startsWith('555')) return true; // 555 is not a real area code
  if (d.length === 10 && d.slice(3) === '0000000') return true;
  return false;
}

function throwawayEmail(email) {
  const domain = String(email || '').toLowerCase().split('@').pop().trim();
  return THROWAWAY_DOMAINS.has(domain);
}

// Returns { field, error } when the sign-up should be refused, or null when it's fine
function fakeSignup({ name, phone, email }) {
  if (throwawayEmail(email))
    return { field: 'email', error: 'Please use your regular email address. Temporary email addresses can’t be used on DirtBidder.' };
  if (TEST_ACCOUNT.test(String(email || ''))) return null;
  if (placeholderName(name))
    return { field: 'name', error: 'Please use your real first and last name. People on DirtBidder need to know who they’re dealing with.' };
  if (fakePhone(phone))
    return { field: 'phone', error: 'That phone number doesn’t look real. Please enter a number where you can be reached.' };
  return null;
}

module.exports = { fakeSignup, placeholderName, fakePhone, throwawayEmail };
