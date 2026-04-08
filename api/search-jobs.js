// /api/search-jobs.js
// Adzuna API — only uses confirmed supported country codes
 
// Adzuna supported EU/EEA countries (confirmed working)
const ADZUNA_SUPPORTED = new Set(['pl', 'de', 'fr', 'it', 'es', 'at', 'gb', 'nl', 'ru', 'in', 'au', 'ca', 'us', 'nz', 'za', 'br', 'sg']);
 
const COUNTRY_MAP = {
  'poland':          'pl',
  'germany':         'de',
  'france':          'fr',
  'italy':           'it',
  'spain':           'es',
  'austria':         'at',
  'united kingdom':  'gb',
  'netherlands':     'nl',
};
 
// Default: Poland + Germany + France (all confirmed supported)
const DEFAULT_COUNTRIES = ['pl', 'de', 'fr'];
 
async function searchAdzuna(countryCode, query, appId, appKey) {
  // Skip unsupported countries silently
  if (!ADZUNA_SUPPORTED.has(countryCode)) {
    console.log(`Skipping unsupported country: ${countryCode}`);
    return [];
  }
 
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${countryCode}/search/1`);
  url.searchParams.set('app_id', appId);
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('what', query);
  url.searchParams.set('results_per_page', '10');
  url.searchParams.set('max_days_old', '30');
  url.searchParams.set('sort_by', 'date');
  url.searchParams.set('content-type', 'application/json');
 
  const response = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' }
  });
 
  if (!response.ok) {
    const err = await response.text();
    console.error(`Adzuna error (${countryCode}):`, err.slice(0, 200));
    return [];
  }
 
  const data = await response.json();
  return (data.results || []).map(j => ({ ...j, _country: countryCode }));
}
 
function normaliseJob(j) {
  return {
    id: j.id,
    title: j.title || '',
    company: j.company?.display_name || '',
    location: j.location?.display_name || '',
    country: j._country || '',
    type: j.contract_time || j.contract_type || '',
    description: (j.description || '').slice(0, 600),
    applyUrl: j.redirect_url || '',
    postedAt: j.created || null,
  };
}
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { query, countries } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });
 
  const appId  = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return res.status(500).json({ error: 'Adzuna API keys not configured.' });
 
  // Resolve selected countries, fallback to defaults
  let codes;
  if (Array.isArray(countries) && countries.length > 0) {
    codes = countries.map(c => COUNTRY_MAP[c.toLowerCase()]).filter(Boolean);
    if (codes.length === 0) codes = DEFAULT_COUNTRIES;
  } else {
    codes = DEFAULT_COUNTRIES;
  }
 
  try {
    const results = await Promise.allSettled(
      codes.map(code => searchAdzuna(code, query, appId, appKey))
    );
 
    const allRaw = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
 
    // Deduplicate by id
    const seen = new Set();
    const unique = allRaw.filter(j => {
      if (!j.id || seen.has(j.id)) return false;
      seen.add(j.id);
      return true;
    });
 
    // Sort freshest first
    unique.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
 
    const jobs = unique.slice(0, 10).map(normaliseJob);
    console.log(`search-jobs: found ${jobs.length} jobs for "${query}" in [${codes.join(', ')}]`);
    return res.status(200).json({ jobs });
 
  } catch (err) {
    console.error('search-jobs error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
