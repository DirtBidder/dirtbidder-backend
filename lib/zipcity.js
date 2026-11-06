// Turns a 5-digit ZIP into "Town, ST" (free lookup at api.zippopotam.us, no key) and saves it on the user
// as profile.zipCity, so HQ and owner emails can show a town instead of a bare ZIP.
const cache = new Map();
const coordCache = new Map(); // ZIP -> { lat, lng } of the town, filled by the same lookup

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
    if (p && p.latitude && p.longitude) coordCache.set(z, { lat: Number(p.latitude), lng: Number(p.longitude) });
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

// Rough center of a ZIP's town (same free lookup), for "about 25 miles away". Returns null if unknown.
async function coords(zip) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (z.length !== 5) return null;
  if (!coordCache.has(z)) { cache.delete(z); await lookup(z); }
  return coordCache.get(z) || null;
}

// Straight-line miles between two points
function miles(a, b) {
  if (!a || !b) return null;
  const R = 3958.8, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

module.exports = { lookup, fillUser, backfill, coords, miles };
