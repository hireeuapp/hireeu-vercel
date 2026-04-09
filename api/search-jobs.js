// /api/search-jobs.js
// Sources:
//   1. Jooble — Poland priority, aggregates Pracuj.pl, OLX, local boards (free, needs JOOBLE_API_KEY)
//   2. Adzuna — EU coverage for non-Poland countries (free, needs ADZUNA_APP_ID + ADZUNA_APP_KEY)
// Results are merged, deduplicated, and sorted freshest first.
// Poland results appear first regardless of date.

const ADZUNA_COUNTRY_MAP = {
  'germany':         'de',
  'france':          'fr',
  'italy':           'it',
  'spain':           'es',
  'austria':         'at',
  'united kingdom':  'gb',
  'netherlands':     'nl',
};

// ── Jooble ──
async function searchJooble(query, location, apiKey) {
  const response = await fetch(`https://jooble.org/api/${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keywords: query,
      location: location || 'Poland',
      page: 1,
      resultsOnPage: 15,
    })
  });

  if (!response.ok) {
    console.error('Jooble error:', response.status, await response.text().catch(() => ''));
    return [];
  }

  const data = await response.json();
  return (data.jobs || []).map(j => ({
    id: `jooble_${j.id || Math.random()}`,
    title: j.title || '',
    company: j.company || '',
    location: j.location || location || 'Poland',
    country: 'pl',
    type: j.type || '',
    description: (j.snippet || '').slice(0, 600),
    applyUrl: j.link || '',
    postedAt: j.updated ? new Date(j.updated).toISOString() : null,
    source: 'jooble',
  }));
}

// ── Adzuna ──
async function searchAdzuna(countryCode, query, appId, appKey) {
  const SUPPORTED = new Set(['de','fr','it','es','at','gb','nl','pl']);
  if (!SUPPORTED.has(countryCode)) return [];

  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${countryCode}/search/1`);
  url.searchParams.set('app_id', appId);
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('what', query);
  url.searchParams.set('results_per_page', '10');
  url.searchParams.set('max_days_old', '30');
  url.searchParams.set('sort_by', 'date');

  const response = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' }
  });

  if (!response.ok) {
    console.error(`Adzuna error (${countryCode}):`, response.status);
    return [];
  }

  const data = await response.json();
  return (data.results || []).map(j => ({
    id: `adzuna_${j.id}`,
    title: j.title || '',
    company: j.company?.display_name || '',
    location: j.location?.display_name || '',
    country: countryCode,
    type: j.contract_time || j.contract_type || '',
    description: (j.description || '').slice(0, 600),
    applyUrl: j.redirect_url || '',
    postedAt: j.created || null,
    source: 'adzuna',
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, countries } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const joobleKey  = process.env.JOOBLE_API_KEY;
  const adzunaId   = process.env.ADZUNA_APP_ID;
  const adzunaKey  = process.env.ADZUNA_APP_KEY;

  const hasCountries = Array.isArray(countries) && countries.length > 0;
  const selectedLower = hasCountries ? countries.map(c => c.toLowerCase()) : [];
  const includesPoland = !hasCountries || selectedLower.includes('poland');

  // Build parallel tasks
  const tasks = [];

  // Always search Poland via Jooble if Poland is selected or no country selected
  if (includesPoland && joobleKey) {
    tasks.push(searchJooble(query, 'Poland', joobleKey));
  } else if (includesPoland && adzunaId) {
    // Fallback to Adzuna Poland if no Jooble key
    tasks.push(searchAdzuna('pl', query, adzunaId, adzunaKey));
  }

  // Add Adzuna for other selected countries
  if (hasCountries && adzunaId) {
    for (const country of selectedLower) {
      if (country === 'poland') continue; // already handled above
      const code = ADZUNA_COUNTRY_MAP[country];
      if (code) tasks.push(searchAdzuna(code, query, adzunaId, adzunaKey));
    }
  } else if (!hasCountries && adzunaId) {
    // No country selected — also search DE and FR as EU fallback
    tasks.push(searchAdzuna('de', query, adzunaId, adzunaKey));
    tasks.push(searchAdzuna('fr', query, adzunaId, adzunaKey));
  }

  if (tasks.length === 0) {
    return res.status(500).json({ error: 'No job search services configured. Check API keys.' });
  }

  try {
    const results = await Promise.allSettled(tasks);
    const allJobs = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

    // Deduplicate by id
    const seen = new Set();
    const unique = allJobs.filter(j => {
      if (!j.id || seen.has(j.id)) return false;
      seen.add(j.id);
      return true;
    });

    // Sort: Poland (Jooble) first, then by date
    unique.sort((a, b) => {
      const aPoland = a.country === 'pl' ? 0 : 1;
      const bPoland = b.country === 'pl' ? 0 : 1;
      if (aPoland !== bPoland) return aPoland - bPoland;
      return new Date(b.postedAt || 0) - new Date(a.postedAt || 0);
    });

    const jobs = unique.slice(0, 15);
    console.log(`search-jobs: ${jobs.length} jobs — ${jobs.filter(j=>j.country==='pl').length} Poland, ${jobs.filter(j=>j.country!=='pl').length} other`);

    return res.status(200).json({ jobs });

  } catch (err) {
    console.error('search-jobs error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
