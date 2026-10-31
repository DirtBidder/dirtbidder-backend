// Turns a 5-digit ZIP into "Town, ST" (free lookup at api.zippopotam.us, no key) and saves it on the user
// as profile.zipCity, so HQ and owner emails can show a town instead of a bare ZIP.
const cache = new Map();

async function lookup(zip) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (z.length !== 5) return '';
  if (cache.has(z)) return cache.get(z);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch('https://api.zippopotam.us/us/' + z, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) { cache.set(z, ''); return ''; }
    const d = await r.json();
    const p = d.places && d.places[0];
    const name = p ? `${p['place name']}, ${p['state abbreviation']}` : '';
    cache.set(z, name);
    return name;
  } catch (e) { return ''; }
}

// Look up and save one user's town (returns it). Safe to call any time; never throws.
async function fillUser(pool, userId) {
  try {
    const u = (await pool.query("SELECT profile->>'zip' AS zip FROM users WHERE id = $1", [userId])).rows[0];
    if (!u || !u.zip) return '';
    const town = await lookup(u.zip);
    if (town) await pool.query("UPDATE users SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object('zipCity', $2::text) WHERE id = $1", [userId, town]);
    return town;
  } catch (e) { return ''; }
}

// Fill in towns for everyone who has a ZIP but no town yet (runs once at startup, gently)
async function backfill(pool) {
  const rows = (await pool.query(
    "SELECT id FROM users WHERE COALESCE(profile->>'zip', '') ~ '^[0-9]{5}' AND COALESCE(profile->>'zipCity', '') = '' ORDER BY id LIMIT 1000")).rows;
  let n = 0;
  for (const r of rows) { if (await fillUser(pool, r.id)) n++; await new Promise(res => setTimeout(res, 250)); }
  if (rows.length) console.log(`ZIP towns filled in: ${n} of ${rows.length}`);
}

module.exports = { lookup, fillUser, backfill };
