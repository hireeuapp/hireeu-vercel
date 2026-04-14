// /api/search-jobs.js
// Sources: JSearch (RapidAPI) + Adzuna + Railway scraper (async cache)
// Filter: English-language jobs only (heuristic)
// CV-aware: accepts parsed CV skills to pre-score relevance before AI scoring

const ADZUNA_MAP = {
  poland: 'pl', germany: 'de', france: 'fr', italy: 'it',
  spain: 'es', austria: 'at', 'united kingdom': 'gb', netherlands: 'nl',
};

// ── English detection ────────────────────────────────────────────────────────
// Heuristic: checks for common non-English chars + high-frequency English words
// Intentionally lenient — only blocks clearly non-English content
const NON_ENGLISH_PATTERNS = [
  /[àáâãäåæçèéêëìíîïðñòóôõöùúûüýþßœ]{3,}/i,   // French/German/Spanish diacritics
  /[ąćęłńóśźż]/i,                                // Polish specific
  /[\u0400-\u04FF]/,                              // Cyrillic
  /[\u4E00-\u9FFF]/,                              // Chinese
  /[\u3040-\u309F\u30A0-\u30FF]/,                // Japanese
  /[\u0600-\u06FF]/,                              // Arabic
];

const ENGLISH_SIGNALS = [
  /\b(the|and|for|with|you|our|this|will|have|are|we|your|that|from|an?)\b/gi
];

function isLikelyEnglish(text) {
  if (!text || text.length < 30) return true; // too short to tell — keep it

  const sample = text.slice(0, 600);

  // Fail fast on strong non-English character patterns
  for (const pat of NON_ENGLISH_PATTERNS) {
    if (pat.test(sample)) return false;
  }

  // Require at least a few common English words
  const englishMatches = (sample.match(ENGLISH_SIGNALS[0]) || []).length;
  if (sample.length > 100 && englishMatches < 4) return false;

  return true;
}

function isEnglishJob(job) {
  // Check title + description together
  const combined = `${job.title} ${job.description}`;
  return isLikelyEnglish(combined);
}

// ── JSearch (RapidAPI) ───────────────────────────────────────────────────────
// Covers: worldwide, great English-language results, Poland included
async function fetchJSearch(role, countries, apiKey) {
  const results = [];

  // Build location queries — JSearch takes natural language location
  const locations = [];
  if (!countries.length || countries.includes('poland')) locations.push('Poland');
  const euCountries = countries.filter(c => c !== 'poland' && ADZUNA_MAP[c]);
  if (!countries.length) {
    // Default: Poland + top EU countries with English job markets
    locations.push('Germany', 'Netherlands', 'Austria');
  } else {
    const nameMap = { de: 'Germany', fr: 'France', it: 'Italy', es: 'Spain', at: 'Austria', gb: 'United Kingdom', nl: 'Netherlands' };
    for (const c of euCountries) { if (nameMap[ADZUNA_MAP[c]]) locations.push(nameMap[ADZUNA_MAP[c]]); }
  }

  // Run one query per location (parallel), 10 results each
  const fetches = locations.map(async (location) => {
    try {
      const url = new URL('https://jsearch.p.rapidapi.com/search');
      url.searchParams.set('query', `${role} in ${location}`);
      url.searchParams.set('num_pages', '1');
      url.searchParams.set('page', '1');
      url.searchParams.set('date_posted', 'month');
      url.searchParams.set('language', 'en_GB'); // prefer English listings

      const r = await fetch(url.toString(), {
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        },
        signal: AbortSignal.timeout(12000),
      });

      if (!r.ok) { console.error(`JSearch ${location}:`, r.status); return []; }
      const d = await r.json();

      return (d.data || []).slice(0, 10).map(j => ({
        id: 'js_' + (j.job_id || Math.random()),
        title: j.job_title || '',
        company: j.employer_name || '',
        location: [j.job_city, j.job_country].filter(Boolean).join(', ') || location,
        description: (j.job_description || '').slice(0, 1000),
        applyUrl: j.job_apply_link || j.job_google_link || '',
        postedAt: j.job_posted_at_datetime_utc || null,
        source: 'JSearch',
        employmentType: j.job_employment_type || '',
        isRemote: j.job_is_remote || false,
      }));
    } catch (e) {
      console.error(`JSearch ${location} error:`, e.message);
      return [];
    }
  });

  const perLocation = await Promise.all(fetches);
  return perLocation.flat();
}

// ── Adzuna ───────────────────────────────────────────────────────────────────
async function fetchAdzuna(code, query, appId, appKey) {
  try {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${code}/search/1`);
    url.searchParams.set('app_id', appId);
    url.searchParams.set('app_key', appKey);
    url.searchParams.set('what', query);
    url.searchParams.set('results_per_page', '15');
    url.searchParams.set('max_days_old', '30');
    url.searchParams.set('sort_by', 'date');
    const r = await fetch(url.toString(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) { console.error('Adzuna', code, r.status); return []; }
    const d = await r.json();
    return (d.results || []).map(j => ({
      id: 'a_' + j.id,
      title: j.title || '',
      company: j.company?.display_name || '',
      location: j.location?.display_name || '',
      description: (j.description || '').slice(0, 1000),
      applyUrl: j.redirect_url || '',
      postedAt: j.created || null,
      source: 'Adzuna',
    }));
  } catch (e) { console.error('Adzuna error:', e.message); return []; }
}

// ── Railway scraper (async cache) ────────────────────────────────────────────
function kickOffRailwayScrape(role, scraperUrl) {
  fetch(`${scraperUrl}/scrape-async?role=${encodeURIComponent(role)}`, {
    signal: AbortSignal.timeout(5000),
  })
    .then(r => r.json())
    .then(d => console.log(`[railway] trigger: ${d.triggered ? 'started' : d.reason}`))
    .catch(e => console.error('[railway] trigger error:', e.message));
}

async function fetchRailwayCached(role, scraperUrl) {
  try {
    const r = await fetch(
      `${scraperUrl}/scrape-cached?role=${encodeURIComponent(role)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return [];
    const { status, jobs } = await r.json();
    console.log(`[railway] status="${status}" jobs=${jobs?.length ?? 0}`);
    if (status !== 'done' && status !== 'stale') return [];
    return (jobs || []).map(j => ({
      id: j.id || ('sc_' + encodeURIComponent(j.applyUrl || Math.random())),
      title: j.title || '',
      company: j.company || '',
      location: j.location || 'Poland',
      description: (j.description || '').slice(0, 1000),
      applyUrl: j.applyUrl || j.url || '',
      postedAt: null,
      source: j.source || 'JustJoinIT',
    }));
  } catch (e) {
    console.error('[railway] cached fetch error:', e.message);
    return [];
  }
}

// ── CV-based pre-filter ───────────────────────────────────────────────────────
// Quick keyword overlap check — removes clearly irrelevant jobs before AI scoring
// This is intentionally lenient (keeps borderline cases)
function cvRelevanceScore(job, cvSkills, role) {
  const text = `${job.title} ${job.description}`.toLowerCase();
  const roleWords = role.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  // Title must loosely match the role — strict gate
  const titleMatch = roleWords.some(w => job.title.toLowerCase().includes(w));
  if (!titleMatch) return 0;

  if (!cvSkills || cvSkills.length === 0) return 50; // no CV skills to check — keep

  // Count how many CV skills appear in the job
  let hits = 0;
  for (const skill of cvSkills) {
    if (text.includes(skill.toLowerCase())) hits++;
  }

  const ratio = hits / cvSkills.length;
  // Return a rough score 20–80 — we keep anything above 15
  return Math.round(20 + ratio * 60);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { role, countries, cvSkills } = req.body;
  if (!role) return res.status(400).json({ error: 'Missing role' });

  const jsearchKey  = process.env.JSEARCH_API_KEY;
  const adzunaId    = process.env.ADZUNA_APP_ID;
  const adzunaKey   = process.env.ADZUNA_APP_KEY;
  const scraperUrl  = process.env.SCRAPER_URL;

  const selectedLower = Array.isArray(countries) && countries.length > 0
    ? countries.map(c => c.toLowerCase())
    : [];

  const includesPoland = selectedLower.length === 0 || selectedLower.includes('poland');

  // ── Build tasks ──────────────────────────────────────────────────────────────
  const tasks = [];

  // JSearch — best English job coverage
  if (jsearchKey) {
    tasks.push(fetchJSearch(role, selectedLower, jsearchKey));
  }

  // Adzuna — good for Poland + EU
  if (adzunaId) {
    const codes = selectedLower.length > 0
      ? selectedLower.map(c => ADZUNA_MAP[c]).filter(Boolean)
      : ['pl', 'de', 'nl']; // sensible defaults for English jobs in EU
    for (const code of codes) {
      tasks.push(fetchAdzuna(code, role, adzunaId, adzunaKey));
    }
  }

  if (tasks.length === 0) return res.status(500).json({ error: 'No job API keys configured. Add JSEARCH_API_KEY or ADZUNA_APP_ID.' });

  // Railway scraper (async)
  let railwayCachedPromise = Promise.resolve([]);
  if (scraperUrl && includesPoland) {
    kickOffRailwayScrape(role, scraperUrl);
    railwayCachedPromise = fetchRailwayCached(role, scraperUrl);
    tasks.push(railwayCachedPromise);
  }

  // ── Fetch all in parallel ────────────────────────────────────────────────────
  const settled = await Promise.allSettled(tasks);
  const all = settled.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // ── Deduplicate by id ────────────────────────────────────────────────────────
  const seen = new Set();
  const unique = all.filter(j => {
    if (!j.id || seen.has(j.id)) return false;
    seen.add(j.id); return true;
  });

  // ── English filter ───────────────────────────────────────────────────────────
  const englishOnly = unique.filter(isEnglishJob);
  console.log(`English filter: ${unique.length} → ${englishOnly.length} jobs`);

  // ── CV relevance pre-filter ──────────────────────────────────────────────────
  // Score each job, drop clear mismatches (score 0 = title doesn't match role at all)
  const skills = Array.isArray(cvSkills) ? cvSkills : [];
  const withRelevance = englishOnly.map(j => ({
    ...j,
    _preScore: cvRelevanceScore(j, skills, role),
  }));

  // Remove jobs where title doesn't match role at all
  const titleFiltered = withRelevance.filter(j => j._preScore > 0);

  // Sort by pre-score so AI scorer sees best candidates first
  titleFiltered.sort((a, b) => b._preScore - a._preScore);

  // Cap at 40 to keep AI scoring fast — take the most relevant ones
  const jobs = titleFiltered.slice(0, 40).map(({ _preScore, ...j }) => j);

  const railwayCached = await railwayCachedPromise;
  const railwayStatus = !scraperUrl ? 'disabled'
    : railwayCached.length > 0 ? 'included' : 'pending';

  console.log(
    `search-jobs: ${unique.length} raw → ${englishOnly.length} english → ${titleFiltered.length} title-matched → returning ${jobs.length} | railway=${railwayStatus}`
  );

  return res.status(200).json({ jobs, railwayStatus });
}
