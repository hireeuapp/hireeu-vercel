// /api/search-jobs.js
// Step A: Fetch jobs from Jooble (Poland) + Adzuna (EU) + Apify JustJoinIT + Apify Pracuj.pl
// Step B: Pre-filter by title match — no AI involved
 
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
 
// Apify JustJoinIT scraper — piotrv1001~just-join-it-scraper
// Extracts IT/tech jobs from justjoin.it filtered by keyword.
// Uses run-sync endpoint (waits up to 60s). Fails silently.
async function fetchJustJoinIT(query, apifyToken) {
  try {
    const url = `https://api.apify.com/v2/acts/piotrv1001~just-join-it-scraper/run-sync-get-dataset-items?token=${apifyToken}&timeout=60`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: query,
        maxItems: 20,
      }),
    });
    if (!r.ok) { console.error('JustJoinIT Apify', r.status, await r.text()); return []; }
    const items = await r.json();
    return (Array.isArray(items) ? items : []).map(j => ({
      id: 'jjit_' + (j.slug || j.id || Math.random()),
      title: j.title || j.jobTitle || '',
      company: j.companyName || j.company || '',
      location: j.city || j.location || 'Poland',
      description: (j.description || j.bodyText || '').slice(0, 800),
      applyUrl: j.url || (j.slug ? `https://justjoin.it/job-offer/${j.slug}` : ''),
      postedAt: j.publishedAt || j.postedAt || null,
      salaryFrom: j.salaryFrom || j.salaryMin || null,
      salaryTo: j.salaryTo || j.salaryMax || null,
      currency: j.currency || null,
      source: 'JustJoinIT',
    }));
  } catch (e) { console.error('JustJoinIT error:', e.message); return []; }
}
 
// Apify Pracuj.pl scraper — trev0n~pracuj-pl-scraper
// Builds a Pracuj.pl search URL from the role query and passes it to the actor.
// Uses run-sync endpoint (waits up to 60s). Fails silently.
async function fetchPracuj(query, apifyToken) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `https://www.pracuj.pl/praca/${encodedQuery};kw/polska;ct,1`;
 
    const url = `https://api.apify.com/v2/acts/trev0n~pracuj-pl-scraper/run-sync-get-dataset-items?token=${apifyToken}&timeout=60`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrl: searchUrl,
        maxItems: 20,
      }),
    });
    if (!r.ok) { console.error('Pracuj Apify', r.status, await r.text()); return []; }
    const items = await r.json();
    return (Array.isArray(items) ? items : []).map(j => ({
      id: 'prc_' + (j.id || j.jobId || Math.random()),
      title: j.jobTitle || j.title || '',
      company: j.companyName || j.company || '',
      location: j.location || j.city || 'Poland',
      description: (j.description || j.jobDescription || '').slice(0, 800),
      applyUrl: j.url || j.jobUrl || '',
      postedAt: j.postedAt || j.publishedAt || null,
      salaryFrom: j.salaryFrom || null,
      salaryTo: j.salaryTo || null,
      currency: j.currency || 'PLN',
      source: 'Pracuj.pl',
    }));
  } catch (e) { console.error('Pracuj error:', e.message); return []; }
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
  const apifyToken = process.env.APIFY_API_TOKEN;
 
  const selectedLower = Array.isArray(countries) && countries.length > 0
    ? countries.map(c => c.toLowerCase())
    : [];
 
  const includesPoland = selectedLower.length === 0 || selectedLower.includes('poland');
 
  const tasks = [];
 
  // Jooble / Adzuna Poland
  if (includesPoland && joobleKey) tasks.push(fetchJooble(role, joobleKey));
  else if (includesPoland && adzunaId) tasks.push(fetchAdzuna('pl', role, adzunaId, adzunaKey));
 
  // Adzuna EU countries
  if (adzunaId) {
    const euCountries = selectedLower.length > 0
      ? selectedLower.filter(c => c !== 'poland').map(c => ADZUNA_MAP[c]).filter(Boolean)
      : ['de', 'fr'];
    for (const code of euCountries) tasks.push(fetchAdzuna(code, role, adzunaId, adzunaKey));
  }
 
  // Apify scrapers — only run when token present and Poland is in scope
  if (apifyToken && includesPoland) {
    tasks.push(fetchJustJoinIT(role, apifyToken));
    tasks.push(fetchPracuj(role, apifyToken));
  }
 
  if (tasks.length === 0) return res.status(500).json({ error: 'No job API keys configured.' });
 
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
 
  // If pre-filter kills everything (very niche role), fall back to all
  const jobs = (filtered.length >= 3 ? filtered : unique).slice(0, 30);
 
  console.log(`search-jobs: ${unique.length} total → ${filtered.length} title-matched → returning ${jobs.length}`);
  return res.status(200).json({ jobs });
}
