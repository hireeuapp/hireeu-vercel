// /api/search-jobs.js
// Sources: JSearch (RapidAPI) + Adzuna
// No scraper dependency whatsoever.
// Key feature: role synonym expansion — "testing" → ["QA engineer","software tester","manual tester","quality assurance"]
// so one vague input catches all real job title variants across both APIs.

// ── Role synonym map ─────────────────────────────────────────────────────────
// Input is lowercased before lookup. Add more rows as needed.
const ROLE_SYNONYMS = {
  'testing':              ['QA engineer', 'software tester', 'manual tester', 'quality assurance'],
  'qa':                   ['QA engineer', 'quality assurance', 'software tester', 'QA analyst'],
  'tester':               ['QA engineer', 'software tester', 'manual tester', 'QA specialist'],
  'qa engineer':          ['QA engineer', 'quality assurance engineer', 'software tester'],
  'qa tester':            ['QA tester', 'software tester', 'manual tester', 'QA engineer'],
  'manual tester':        ['manual tester', 'QA engineer', 'software tester'],
  'automation tester':    ['automation tester', 'QA automation engineer', 'SDET', 'test automation engineer'],
  'developer':            ['software developer', 'software engineer', 'backend developer', 'frontend developer'],
  'frontend':             ['frontend developer', 'React developer', 'UI developer', 'JavaScript developer'],
  'backend':              ['backend developer', 'Node.js developer', 'Java developer', 'Python developer'],
  'fullstack':            ['fullstack developer', 'full stack developer', 'software engineer'],
  'devops':               ['DevOps engineer', 'SRE', 'platform engineer', 'infrastructure engineer'],
  'data':                 ['data analyst', 'data engineer', 'business intelligence analyst', 'data scientist'],
  'data analyst':         ['data analyst', 'business intelligence analyst', 'BI analyst'],
  'pm':                   ['project manager', 'IT project manager', 'scrum master', 'delivery manager'],
  'project manager':      ['IT project manager', 'project manager', 'scrum master'],
  'product manager':      ['product manager', 'product owner', 'PO'],
  'java':                 ['Java developer', 'Java engineer', 'backend Java developer'],
  'python':               ['Python developer', 'Python engineer', 'backend Python developer'],
  'javascript':           ['JavaScript developer', 'frontend developer', 'Node.js developer'],
  'react':                ['React developer', 'frontend developer', 'React engineer'],
  'mobile':               ['mobile developer', 'Android developer', 'iOS developer', 'React Native developer'],
  'android':              ['Android developer', 'mobile developer', 'Kotlin developer'],
  'ios':                  ['iOS developer', 'Swift developer', 'mobile developer'],
  'security':             ['cybersecurity engineer', 'security analyst', 'penetration tester', 'infosec engineer'],
  'support':              ['IT support specialist', 'technical support engineer', 'helpdesk engineer'],
  'analyst':              ['business analyst', 'data analyst', 'systems analyst', 'IT analyst'],
};

function expandRole(role) {
  const key = role.trim().toLowerCase();
  // Exact match first
  if (ROLE_SYNONYMS[key]) return ROLE_SYNONYMS[key];
  // Partial match — e.g. "game tester" contains "tester"
  for (const [k, v] of Object.entries(ROLE_SYNONYMS)) {
    if (key.includes(k) || k.includes(key)) return [role, ...v].slice(0, 4);
  }
  // No match — just use what they typed
  return [role];
}

// ── Adzuna country map ────────────────────────────────────────────────────────
const ADZUNA_MAP = {
  poland: 'pl', germany: 'de', france: 'fr', italy: 'it',
  spain: 'es', austria: 'at', 'united kingdom': 'gb', netherlands: 'nl',
};

// ── English detection ────────────────────────────────────────────────────────
const NON_ENGLISH_PATTERNS = [
  /[àáâãäåæçèéêëìíîïðñòóôõöùúûüýþßœ]{3,}/i,
  /[\u0600-\u06FF\u0590-\u05FF]{4,}/,
  /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]{3,}/,
];
const ENGLISH_WORD_RE = /\b(the|and|for|with|you|our|this|will|have|are|we|your|that|from|an?)\b/gi;

function isEnglishJob(job) {
  const sample = `${job.title} ${job.description}`.slice(0, 600);
  if (sample.length < 40) return true;
  for (const pat of NON_ENGLISH_PATTERNS) if (pat.test(sample)) return false;
  const hits = (sample.match(ENGLISH_WORD_RE) || []).length;
  if (sample.length > 120 && hits < 4) return false;
  return true;
}

// ── Deduplication ────────────────────────────────────────────────────────────
function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    const key = normalize(j.title) + '||' + normalize(j.company);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── JSearch ──────────────────────────────────────────────────────────────────
// One query per synonym, Poland-first, then EU fallback
async function fetchJSearch(queries, apiKey) {
  // Always anchor to Poland. Each synonym gets its own query.
  const fetches = queries.map(async (q) => {
    try {
      const url = new URL('https://jsearch.p.rapidapi.com/search');
      url.searchParams.set('query', `${q} in Poland`);
      url.searchParams.set('num_pages', '1');
      url.searchParams.set('page', '1');
      url.searchParams.set('date_posted', 'month');
      url.searchParams.set('language', 'en_GB');

      const r = await fetch(url.toString(), {
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        },
        signal: AbortSignal.timeout(12000),
      });

      if (!r.ok) { console.error(`JSearch "${q}":`, r.status); return []; }
      const d = await r.json();

      return (d.data || []).slice(0, 10).map(j => ({
        id: 'js_' + (j.job_id || Math.random()),
        title: j.job_title || '',
        company: j.employer_name || '',
        location: [j.job_city, j.job_country].filter(Boolean).join(', ') || 'Poland',
        description: (j.job_description || '').slice(0, 1000),
        applyUrl: j.job_apply_link || j.job_google_link || '',
        postedAt: j.job_posted_at_datetime_utc || null,
        source: 'JSearch',
        isRemote: j.job_is_remote || false,
      }));
    } catch (e) {
      console.error(`JSearch "${q}" error:`, e.message);
      return [];
    }
  });

  const results = await Promise.all(fetches);
  return results.flat();
}

// ── Adzuna ───────────────────────────────────────────────────────────────────
// One query per synonym against Poland (pl), then GB as English fallback
async function fetchAdzuna(queries, appId, appKey) {
  const codes = ['pl', 'gb']; // Poland first, UK as English-job fallback

  const fetches = [];
  for (const code of codes) {
    for (const q of queries.slice(0, 2)) { // cap at 2 synonyms × 2 countries = 4 calls
      fetches.push((async () => {
        try {
          const url = new URL(`https://api.adzuna.com/v1/api/jobs/${code}/search/1`);
          url.searchParams.set('app_id', appId);
          url.searchParams.set('app_key', appKey);
          url.searchParams.set('what', q);
          url.searchParams.set('results_per_page', '15');
          url.searchParams.set('max_days_old', '30');
          url.searchParams.set('sort_by', 'date');

          const r = await fetch(url.toString(), {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) { console.error(`Adzuna ${code} "${q}":`, r.status); return []; }
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
            isRemote: false,
          }));
        } catch (e) {
          console.error(`Adzuna ${code} "${q}" error:`, e.message);
          return [];
        }
      })());
    }
  }

  const results = await Promise.all(fetches);
  return results.flat();
}

// ── Citizenship / clearance blacklist ────────────────────────────────────────
const BLOCKED_PHRASES = [
  'security clearance', 'us citizen', 'u.s. citizen', 'nato secret',
  'only citizens', 'must be a citizen', 'citizenship required',
];
function isBlocked(job) {
  const text = `${job.title} ${job.description}`.toLowerCase();
  return BLOCKED_PHRASES.some(p => text.includes(p));
}

// ── Poland boost ─────────────────────────────────────────────────────────────
function isPoland(job) {
  const loc = (job.location || '').toLowerCase();
  return loc.includes('poland') || loc.includes('warszawa') || loc.includes('warsaw') ||
    loc.includes('kraków') || loc.includes('krakow') || loc.includes('wrocław') ||
    loc.includes('wroclaw') || loc.includes('gdańsk') || loc.includes('gdansk') ||
    loc.includes('poznań') || loc.includes('poznan') || loc.includes('łódź') || loc.includes('lodz');
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { role, cvSkills } = req.body;
  if (!role) return res.status(400).json({ error: 'Missing role' });

  const jsearchKey = process.env.JSEARCH_API_KEY;
  const adzunaId   = process.env.ADZUNA_APP_ID;
  const adzunaKey  = process.env.ADZUNA_APP_KEY;

  if (!jsearchKey && !adzunaId) {
    return res.status(500).json({ error: 'No API keys configured. Add JSEARCH_API_KEY and/or ADZUNA_APP_ID.' });
  }

  // Expand role into synonyms — this is the core fix for "testing" returning dev jobs
  const queries = expandRole(role);
  console.log(`Role expansion: "${role}" → [${queries.join(', ')}]`);

  // ── Fetch all sources in parallel ────────────────────────────────────────
  const [jsearchJobs, adzunaJobs] = await Promise.all([
    jsearchKey ? fetchJSearch(queries, jsearchKey) : Promise.resolve([]),
    adzunaId   ? fetchAdzuna(queries, adzunaId, adzunaKey) : Promise.resolve([]),
  ]);

  const raw = [...jsearchJobs, ...adzunaJobs];
  console.log(`Raw: jsearch=${jsearchJobs.length} adzuna=${adzunaJobs.length} total=${raw.length}`);

  // ── Deduplicate ──────────────────────────────────────────────────────────
  const unique = dedupe(raw);

  // ── English filter ───────────────────────────────────────────────────────
  const english = unique.filter(isEnglishJob);

  // ── Hard blacklist ───────────────────────────────────────────────────────
  const clean = english.filter(j => !isBlocked(j));

  // ── Sort: Poland first, then by recency ──────────────────────────────────
  clean.sort((a, b) => {
    const ap = isPoland(a) ? 1 : 0;
    const bp = isPoland(b) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    const ad = a.postedAt ? new Date(a.postedAt).getTime() : 0;
    const bd = b.postedAt ? new Date(b.postedAt).getTime() : 0;
    return bd - ad;
  });

  // Cap at 50 — scorer batches in 8s, 50 is fine
  const jobs = clean.slice(0, 50);

  console.log(`search-jobs: ${raw.length} raw → ${unique.length} deduped → ${english.length} english → ${clean.length} clean → ${jobs.length} returned`);
  console.log(`Poland jobs: ${jobs.filter(isPoland).length} / ${jobs.length}`);

  return res.status(200).json({ jobs });
}
