// /api/search-jobs.js
// Async scraper strategy:
//   First search  → fire Railway scrape in background, return Jooble/Adzuna immediately
//   Second search → Railway results are cached; merge them in instantly
//
// Railway endpoints used:
//   GET /scrape-async?role=...   → fire-and-forget, returns immediately
//   GET /scrape-cached?role=...  → returns { status, jobs } from cache

const ADZUNA_MAP = {
  germany: 'de', france: 'fr', italy: 'it',
  spain: 'es', austria: 'at', 'united kingdom': 'gb', netherlands: 'nl',
};

async function fetchJooble(query, apiKey) {
  try {
    const r = await fetch(`https://jooble.org/api/${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: query, location: 'Poland', page: 1, resultsOnPage: 20 })
    });
    if (!r.ok) { console.error('Jooble', r.status); return []; }
    const d = await r.json();
    return (d.jobs || []).map(j => ({
      id: 'j_' + (j.id || Math.random()),
      title: j.title || '',
      company: j.company || '',
      location: j.location || 'Poland',
      description: (j.snippet || '').slice(0, 800),
      applyUrl: j.link || '',
      postedAt: j.updated || null,
      source: 'Poland',
    }));
  } catch (e) { console.error('Jooble error:', e.message); return []; }
}

async function fetchAdzuna(code, query, appId, appKey) {
  try {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${code}/search/1`);
    url.searchParams.set('app_id', appId);
    url.searchParams.set('app_key', appKey);
    url.searchParams.set('what', query);
    url.searchParams.set('results_per_page', '10');
    url.searchParams.set('max_days_old', '30');
    url.searchParams.set('sort_by', 'date');
    const r = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!r.ok) { console.error('Adzuna', code, r.status); return []; }
    const d = await r.json();
    return (d.results || []).map(j => ({
      id: 'a_' + j.id,
      title: j.title || '',
      company: j.company?.display_name || '',
      location: j.location?.display_name || '',
      description: (j.description || '').slice(0, 800),
      applyUrl: j.redirect_url || '',
      postedAt: j.created || null,
      source: 'EU',
    }));
  } catch (e) { console.error('Adzuna error:', e.message); return []; }
}

// Kick off a background scrape on Railway — fire and forget, never awaited
// Returns immediately; Railway will cache results for the next request
function kickOffRailwayScrape(role, scraperUrl) {
  fetch(`${scraperUrl}/scrape-async?role=${encodeURIComponent(role)}`, {
    signal: AbortSignal.timeout(5000),
  })
    .then(r => r.json())
    .then(d => console.log(`[railway] trigger response for "${role}":`, d.triggered ? 'started' : d.reason))
    .catch(e => console.error('[railway] trigger error:', e.message));
  // Intentionally not awaited — this is fire-and-forget
}

// Fetch whatever Railway has cached already (returns immediately)
// Returns [] if nothing is ready yet
async function fetchRailwayCached(role, scraperUrl) {
  try {
    const r = await fetch(
      `${scraperUrl}/scrape-cached?role=${encodeURIComponent(role)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) { console.error('[railway] cached fetch', r.status); return []; }
    const { status, jobs } = await r.json();
    console.log(`[railway] cache status="${status}" jobs=${jobs?.length ?? 0}`);
    if (status === 'done' || status === 'stale') {
      return (jobs || []).map(j => ({
        id: j.id || ('sc_' + encodeURIComponent(j.applyUrl || Math.random())),
        title: j.title || '',
        company: j.company || '',
        location: j.location || 'Poland',
        description: (j.description || '').slice(0, 800),
        applyUrl: j.applyUrl || j.url || '',
        postedAt: null,
        source: j.source || 'JustJoinIT',
      }));
    }
    return [];
  } catch (e) {
    console.error('[railway] cached fetch error:', e.message);
    return [];
  }
}

function titleMatches(jobTitle, targetRole) {
  const jt = jobTitle.toLowerCase();
  const tr = targetRole.toLowerCase();
  const words = tr.split(/\s+/).filter(w => w.length > 2);
  return words.some(w => jt.includes(w));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { role, countries } = req.body;
  if (!role) return res.status(400).json({ error: 'Missing role' });

  const joobleKey  = process.env.JOOBLE_API_KEY;
  const adzunaId   = process.env.ADZUNA_APP_ID;
  const adzunaKey  = process.env.ADZUNA_APP_KEY;
  const scraperUrl = process.env.SCRAPER_URL;

  const selectedLower = Array.isArray(countries) && countries.length > 0
    ? countries.map(c => c.toLowerCase())
    : [];

  const includesPoland = selectedLower.length === 0 || selectedLower.includes('poland');

  // ── 1. Build Jooble / Adzuna tasks (always awaited) ────────────────────────
  const tasks = [];

  if (includesPoland && joobleKey) tasks.push(fetchJooble(role, joobleKey));
  else if (includesPoland && adzunaId) tasks.push(fetchAdzuna('pl', role, adzunaId, adzunaKey));

  if (adzunaId) {
    const euCountries = selectedLower.length > 0
      ? selectedLower.filter(c => c !== 'poland').map(c => ADZUNA_MAP[c]).filter(Boolean)
      : ['de', 'fr'];
    for (const code of euCountries) tasks.push(fetchAdzuna(code, role, adzunaId, adzunaKey));
  }

  if (tasks.length === 0) return res.status(500).json({ error: 'No job API keys configured.' });

  // ── 2. Railway async pattern ────────────────────────────────────────────────
  // Simultaneously:
  //   a) Kick off a background scrape (no-op if already pending/fresh)
  //   b) Fetch whatever is already cached (usually empty on first search)
  let railwayCachedPromise = Promise.resolve([]);
  if (scraperUrl && includesPoland) {
    kickOffRailwayScrape(role, scraperUrl);                    // fire and forget
    railwayCachedPromise = fetchRailwayCached(role, scraperUrl); // fast cache read
    tasks.push(railwayCachedPromise);
  }

  // ── 3. Await all tasks in parallel ─────────────────────────────────────────
  const results = await Promise.allSettled(tasks);
  const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Deduplicate by id
  const seen = new Set();
  const unique = all.filter(j => {
    if (seen.has(j.id)) return false;
    seen.add(j.id); return true;
  });

  // Pre-filter by title match
  const filtered = unique.filter(j => titleMatches(j.title, role));
  const jobs = (filtered.length >= 3 ? filtered : unique).slice(0, 30);

  // Let the client know whether Railway results are included or still pending
  const railwayCached = await railwayCachedPromise;
  const railwayStatus = !scraperUrl
    ? 'disabled'
    : railwayCached.length > 0 ? 'included' : 'pending';

  console.log(
    `search-jobs: ${unique.length} total → ${filtered.length} title-matched → returning ${jobs.length} | railway=${railwayStatus}`
  );

  return res.status(200).json({ jobs, railwayStatus });
}
