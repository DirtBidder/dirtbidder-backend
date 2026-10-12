// Public bid board: upcoming county, city and Iowa DOT jobs with dirt work, each linked to the official notice.
// DirtBidder only lists them. Contractors bid with the agency directly; no money goes through DirtBidder.
//   GET    /api/public-bids           anyone: upcoming bids (hidden and past ones left out)
//   GET    /api/public-bids/all       owner: every bid, including hidden and past
//   POST   /api/public-bids           owner: add a bid
//   PUT    /api/public-bids/:id       owner: change a bid
//   DELETE /api/public-bids/:id       owner: hide a bid (kept, so a starter bid never comes back on restart)
const express = require('express');

const DOT_NOTICE = 'https://iowadot.gov/media/2493/download?inline=';
const DOT_TARGETS = 'https://iowadot.gov/media/2489/download?inline=';
const DOT_LOCAL = 'https://iowadot.gov/media/2496/download?inline=';
const DOT_HOW = 'Bid through Bid Express (bidx.com). Iowa DOT prequalification and a bid bond are required. Questions: Iowa DOT Contracts, 515-239-1414.';
const EST_HOW = 'Estimated date from the Iowa DOT target list. Not advertised yet. Plans and the official notice post about 3 weeks before the letting.';

// Starter bids, checked against the official Iowa DOT documents on Oct 12, 2026
const SEED = [
  ['dot-2026-10-20-008', 'US 169 bridge earthwork, West Fork Des Moines River', 'Iowa DOT', 'Humboldt', 'US 169, 0.6 mi S of IA 3', 'Clearing and grubbing, embankment, excavation, revetment, silt fence', '2026-10-20', '10:00 AM CDT', 'advertised', 'Bid order 008, project BRF-169-7(049). 95 working days.', '$100,000', DOT_HOW, DOT_NOTICE],
  ['dot-2026-10-20-015', 'S 19th St over UP Railroad, Fort Dodge', 'Iowa DOT (City of Fort Dodge)', 'Webster', 'S 19th St, Fort Dodge', 'Clearing and grubbing, embankment, excavation, storm sewer, subdrain, seeding, topsoil', '2026-10-20', '10:00 AM CDT', 'advertised', 'Bid order 015, project BROS-2690(631). 100 working days.', '$150,000', DOT_HOW, DOT_NOTICE],
  ['dot-2026-10-20-102', 'US 30 grading and culverts, Jefferson to Grand Junction', 'Iowa DOT', 'Greene', 'US 30, Buttrick Creek and Jefferson to Grand Junction', 'Embankment, excavation, culvert pipe, revetment, granular shoulders, silt fence', '2026-10-20', '10:00 AM CDT', 'advertised', 'Bid order 102, two projects. 80 working days.', '$500,000', DOT_HOW, DOT_NOTICE],
  ['dot-2026-10-20-014', 'US 30 westbound rebuild, Ames', 'Iowa DOT', 'Story', 'US 30, S Duff Ave to S Dayton Ave and South Skunk River', 'Clearing, excavation, culvert pipe and box culverts, subdrain, revetment, seeding, topsoil', '2026-10-20', '10:00 AM CDT', 'advertised', 'Bid order 014, five projects. 140 working days.', '$750,000', DOT_HOW, DOT_NOTICE],
  ['dot-2026-10-20-104', 'County road grading and culverts near US 30', 'Iowa DOT (Marshall County)', 'Marshall', 'Binford Ave and 245th St, US 30 S 1.2 mi to Brown Ave', 'Embankment, excavation, compaction, culvert pipe, subdrain, seeding, topsoil', '2026-10-20', '10:00 AM CDT', 'advertised', 'Bid order 104, project RFM-C064(149). 105 working days.', '$200,000', DOT_HOW, DOT_NOTICE],
  ['dot-2026-10-20-010', 'A52 over Little Rock River', 'Iowa DOT (Lyon County)', 'Lyon', 'County road A52', 'Clearing, culvert pipe, excavation, revetment, subdrain, seeding, topsoil', '2026-10-20', '10:00 AM CDT', 'advertised', 'Bid order 010, project ER-C060(133). 185 working days.', '$250,000', DOT_HOW, DOT_NOTICE],
  ['dot-2026-10-20-101', 'J64 (310th St) grading and culverts', 'Iowa DOT (Fremont County)', 'Fremont', 'J64, US 275 east 3.5 mi to L68', 'Culvert pipe, precast culvert, excavation, subdrain, seeding, topsoil', '2026-10-20', '10:00 AM CDT', 'advertised', 'Bid order 101, project STP-S-C036(93). 135 working days.', '$250,000', DOT_HOW, DOT_NOTICE],
  ['dot-2026-10-20-002', 'Iowa 3 drainage ditch structure', 'Iowa DOT', 'Bremer', 'Iowa 3, drainage ditch 2.1 mi W of Co Rd V56', 'Excavation, modified subbase', '2026-10-20', '10:00 AM CDT', 'advertised', 'Bid order 002, project BRFN-003-6(073). 50 working days.', '$37,500', DOT_HOW, DOT_NOTICE],
  ['local-2026-10-26-adair', '170th Street box culvert replacement', 'Adair County (through Iowa DOT local letting)', 'Adair', '170th Street', 'Single box culvert replacement (5x5 to 6x6), revetment, granular surfacing, seeding', '2026-10-26', null, 'advertised', 'County project listed on the Iowa DOT local letting page.', null, 'Contact Adair County or see the bulletin on the Iowa DOT local letting page.', DOT_LOCAL],
  ['dot-est-2026-11-17-pocahontas', 'IA 15 bridge replacement, Pilot Creek', 'Iowa DOT', 'Pocahontas', 'IA 15 at N Jct Co Rd C26', 'Bridge replacement', '2026-11-17', null, 'estimated', null, null, EST_HOW, DOT_TARGETS],
  ['dot-est-2026-12-15-webster-144', 'IA 144 twin box culvert replacement, East Buttrick Creek', 'Iowa DOT', 'Webster', 'IA 144, 2.2 mi S of IA 175', 'Twin box culvert replacement', '2026-12-15', null, 'estimated', null, null, EST_HOW, DOT_TARGETS],
  ['dot-est-2026-12-15-sac', '265th St new bridge over small stream', 'Iowa DOT (Sac County)', 'Sac', '265th St, S29 T88N R36W', 'New bridge', '2026-12-15', null, 'estimated', null, null, EST_HOW, DOT_TARGETS],
  ['dot-est-2027-01-20-calhoun-250', '250th St bridge over Drainage District 1-54', 'Iowa DOT (Calhoun County)', 'Calhoun', '250th St, S21 T88 R34', 'Bridge replacement over a drainage ditch', '2027-01-20', null, 'estimated', null, null, EST_HOW, DOT_TARGETS],
  ['dot-est-2027-01-20-calhoun-d33', 'D33 bridge over Drainage District 65', 'Iowa DOT (Calhoun County)', 'Calhoun', 'D33, S19 T88N R32W', 'Bridge replacement over a drainage ditch', '2027-01-20', null, 'estimated', null, null, EST_HOW, DOT_TARGETS]
];

const FIELDS = ['title', 'agency', 'county', 'location', 'work_type', 'letting_date', 'due_time', 'status', 'details', 'bid_bond', 'how_to_bid', 'source_url'];

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS public_bids (
    id SERIAL PRIMARY KEY,
    seed_key TEXT UNIQUE,
    title TEXT NOT NULL,
    agency TEXT NOT NULL,
    county TEXT,
    location TEXT,
    work_type TEXT,
    letting_date DATE NOT NULL,
    due_time TEXT,
    status TEXT NOT NULL DEFAULT 'advertised',
    details TEXT,
    bid_bond TEXT,
    how_to_bid TEXT,
    source_url TEXT NOT NULL,
    hidden BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);
  for (const r of SEED) {
    await pool.query(
      `INSERT INTO public_bids (seed_key, ${FIELDS.join(', ')}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (seed_key) DO NOTHING`, r);
  }
}

function clean(body) {
  const out = {};
  for (const f of FIELDS) {
    if (body[f] === undefined) continue;
    let v = body[f] == null ? null : String(body[f]).trim().slice(0, f === 'details' || f === 'how_to_bid' ? 2000 : 300);
    if (v === '') v = null;
    out[f] = v;
  }
  if (out.status !== undefined && !['advertised', 'estimated'].includes(out.status)) out.status = 'advertised';
  if (out.source_url && !/^https?:\/\//i.test(out.source_url)) return { error: 'The link to the official notice must start with http:// or https://' };
  if (out.letting_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.letting_date)) return { error: 'Pick a bid date' };
  return { data: out };
}

const PUBLIC_COLS = `id, title, agency, county, location, work_type, to_char(letting_date, 'YYYY-MM-DD') AS letting_date, due_time, status, details, bid_bond, how_to_bid, source_url`;

module.exports = (pool, authMiddleware, adminOnly) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT ${PUBLIC_COLS} FROM public_bids
         WHERE NOT hidden AND letting_date >= (NOW() AT TIME ZONE 'America/Chicago')::date
         ORDER BY letting_date, county NULLS LAST, title LIMIT 300`);
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ bids: r.rows });
    } catch (err) {
      console.error('Public bids error:', err.message);
      res.status(500).json({ error: 'Could not load bids' });
    }
  });

  router.get('/all', authMiddleware, adminOnly, async (req, res) => {
    const r = await pool.query(`SELECT ${PUBLIC_COLS}, hidden FROM public_bids ORDER BY letting_date DESC, id DESC LIMIT 500`);
    res.json({ bids: r.rows });
  });

  router.post('/', authMiddleware, adminOnly, async (req, res) => {
    const { data, error } = clean(req.body || {});
    if (error) return res.status(400).json({ error });
    for (const f of ['title', 'agency', 'letting_date', 'source_url'])
      if (!data[f]) return res.status(400).json({ error: 'Fill in the job, the agency, the bid date and the link to the official notice' });
    const cols = Object.keys(data);
    const r = await pool.query(
      `INSERT INTO public_bids (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`,
      cols.map(c => data[c]));
    res.json({ id: r.rows[0].id });
  });

  router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
    const { data, error } = clean(req.body || {});
    if (error) return res.status(400).json({ error });
    if (req.body && req.body.hidden !== undefined) data.hidden = !!req.body.hidden;
    const cols = Object.keys(data);
    if (!cols.length) return res.json({ ok: true });
    for (const f of ['title', 'agency', 'letting_date', 'source_url'])
      if (f in data && !data[f]) return res.status(400).json({ error: 'That field can\'t be empty' });
    const r = await pool.query(
      `UPDATE public_bids SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW() WHERE id = $${cols.length + 1}`,
      [...cols.map(c => data[c]), parseInt(req.params.id, 10)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Bid not found' });
    res.json({ ok: true });
  });

  router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
    const r = await pool.query('UPDATE public_bids SET hidden = TRUE, updated_at = NOW() WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Bid not found' });
    res.json({ ok: true });
  });

  return router;
};
module.exports.migrate = migrate;
