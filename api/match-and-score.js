// /api/match-and-score.js
// LLM extracts facts → deterministic scoring in code
// Returns only jobs where candidate is reasonably qualified (match >= MIN_SCORE)

const MIN_SCORE = 45; // below this = candidate is clearly not a fit, drop it

async function callGroq(prompt, maxTokens = 1500) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.1
    })
  });
  if (!response.ok) throw new Error(`Groq error: ${await response.text()}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

function calculateScore(candidate, jobFacts) {
  // Weights — must sum to 100
  const W_SKILLS    = 45;
  const W_EXP       = 30;
  const W_SENIORITY = 15;
  const W_FIELD     = 10;

  let skillScore  = 0;
  let expScore    = 0;
  let seniorScore = 0;
  let fieldScore  = 0;
  const gaps      = [];
  const strengths = [];

  // ── Skills (0–45) ──────────────────────────────────────────────────────────
  const required   = jobFacts.requiredSkills  || [];
  const critical   = jobFacts.criticalSkills  || [];
  const candSkills = (candidate.skills || []).map(s => s.toLowerCase());

  if (required.length > 0) {
    let matched = 0;
    const matchedNames = [];
    const missingNames = [];

    for (const skill of required) {
      const sl = skill.toLowerCase();
      if (candSkills.some(cs => cs.includes(sl) || sl.includes(cs))) {
        matched++;
        matchedNames.push(skill);
      } else {
        missingNames.push(skill);
      }
    }

    const ratio = matched / required.length;
    skillScore = Math.round(ratio * W_SKILLS);

    if (ratio >= 0.7) strengths.push(`${matched}/${required.length} required skills match`);
    else if (ratio >= 0.4) gaps.push(`only ${matched}/${required.length} required skills`);
    else gaps.push(`major skill gap: missing ${missingNames.slice(0,3).join(', ')}`);

    // Hard penalty per missing critical skill (−10 each, max −30)
    let critPenalty = 0;
    const missingCrit = [];
    for (const cs of critical) {
      const csl = cs.toLowerCase();
      if (!candSkills.some(s => s.includes(csl) || csl.includes(s))) {
        critPenalty += 10;
        missingCrit.push(cs);
      }
    }
    if (missingCrit.length) gaps.push(`missing critical: ${missingCrit.slice(0,2).join(', ')}`);
    skillScore = Math.max(0, skillScore - Math.min(critPenalty, 30));
  } else {
    skillScore = Math.round(W_SKILLS * 0.55); // no requirements listed — partial credit
  }

  // ── Experience (0–30) ──────────────────────────────────────────────────────
  const yearsReq  = jobFacts.yearsRequired || 0;
  const yearsCand = candidate.yearsExperience || 0;

  if (yearsReq === 0) {
    expScore = Math.round(W_EXP * 0.7);
  } else {
    const diff = yearsCand - yearsReq;
    if (diff >= 0) {
      expScore = W_EXP;
      strengths.push(`${yearsCand}yrs experience meets ${yearsReq}yr requirement`);
    } else if (diff === -1) {
      expScore = Math.round(W_EXP * 0.75);
    } else if (diff === -2) {
      expScore = Math.round(W_EXP * 0.45);
      gaps.push(`needs ${yearsReq}yrs, candidate has ~${yearsCand}`);
    } else {
      expScore = Math.round(W_EXP * 0.12);
      gaps.push(`needs ${yearsReq}yrs, candidate has ~${yearsCand}`);
    }
  }

  // ── Seniority (0–15) ───────────────────────────────────────────────────────
  const seniority = jobFacts.seniorityMatch || 'unknown';
  if      (seniority === 'match')          { seniorScore = W_SENIORITY; strengths.push('seniority level matches'); }
  else if (seniority === 'stretch')        { seniorScore = Math.round(W_SENIORITY * 0.25); gaps.push('role is above candidate\'s level'); }
  else if (seniority === 'overqualified')  { seniorScore = Math.round(W_SENIORITY * 0.55); }
  else                                     { seniorScore = Math.round(W_SENIORITY * 0.6); }

  // ── Field (0–10) ───────────────────────────────────────────────────────────
  if      (jobFacts.fieldMatch === true)   { fieldScore = W_FIELD; strengths.push('same domain'); }
  else if (jobFacts.fieldMatch === false)  { fieldScore = 0; gaps.push('different professional domain'); }
  else                                     { fieldScore = Math.round(W_FIELD * 0.5); }

  // Cap at 92 — a perfect match is realistically never 100
  const total = Math.min(92, skillScore + expScore + seniorScore + fieldScore);

  // Build a plain-language reason (1 sentence)
  let reason = '';
  if (gaps.length > 0 && strengths.length > 0) {
    reason = `${strengths[0]}; gap: ${gaps[0]}.`;
  } else if (gaps.length > 0) {
    reason = `Gap: ${gaps.slice(0,2).join('; ')}.`;
  } else {
    reason = `Strong fit — ${strengths.slice(0,2).join(', ')}.`;
  }

  // Collect missing skills for display
  const missingSkills = [];
  for (const cs of critical) {
    const csl = cs.toLowerCase();
    if (!(candidate.skills || []).some(s => s.toLowerCase().includes(csl) || csl.includes(s.toLowerCase()))) {
      missingSkills.push(cs);
    }
  }
  // Also add top non-critical missing skills if score is middling
  if (total < 65 && required.length > 0) {
    const candSkillsLower = (candidate.skills || []).map(s => s.toLowerCase());
    for (const skill of required) {
      if (missingSkills.length >= 4) break;
      const sl = skill.toLowerCase();
      if (!candSkillsLower.some(cs => cs.includes(sl) || sl.includes(cs)) && !missingSkills.includes(skill)) {
        missingSkills.push(skill);
      }
    }
  }

  return { score: total, reason, missingSkills: missingSkills.slice(0, 4) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { summary, skills, yearsExperience, jobs } = req.body;
  if (!summary || !jobs?.length) return res.status(400).json({ error: 'Missing summary or jobs' });

  const candidate = {
    summary,
    skills: skills || [],
    yearsExperience: yearsExperience || 0,
  };

  // Process in batches of 8 to stay within Groq token limits
  const BATCH = 8;
  const allScored = [];

  for (let start = 0; start < jobs.length; start += BATCH) {
    const batch = jobs.slice(start, start + BATCH);

    const jobList = batch.map((j, i) =>
      `[${i}] ${j.title} at ${j.company} (${j.location})\n${(j.description || '').slice(0, 600)}`
    ).join('\n\n');

    const prompt = `You are a fact extractor for a job-matching tool. Extract ONLY objective facts — do NOT score or judge.

CANDIDATE PROFILE:
${summary}
Skills: ${(skills || []).join(', ')}
Years of experience: ${yearsExperience || 'unknown'}

For each job below extract:
- yearsRequired: minimum years explicitly required (number, 0 if not stated)
- requiredSkills: all skills/tools explicitly required or strongly preferred (list of strings)
- criticalSkills: subset that are clearly non-negotiable (list, can be empty)
- seniorityMatch: "match" | "stretch" | "overqualified" | "unknown"
  - match = candidate level fits the role
  - stretch = role is clearly senior to the candidate
  - overqualified = role is clearly junior to the candidate
- fieldMatch: true if same professional domain as candidate, false if clearly different, null if unclear

JOB LISTINGS:
${jobList}

Respond ONLY with JSON — no markdown, no explanation:
{
  "jobs": [
    {
      "index": 0,
      "yearsRequired": 3,
      "requiredSkills": ["React", "TypeScript", "REST APIs"],
      "criticalSkills": ["React"],
      "seniorityMatch": "match",
      "fieldMatch": true
    }
  ]
}`;

    try {
      const text = await callGroq(prompt, 1500);
      let extracted;
      try {
        extracted = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch {
        console.error('Extraction parse error (batch):', text.slice(0, 200));
        // Fallback: give all jobs in batch a middling score
        batch.forEach(job => allScored.push({ ...job, match: 50, reason: 'Could not fully analyse this listing.', missingSkills: [] }));
        continue;
      }

      const jobFacts = extracted.jobs || [];
      const scoredIndices = new Set();

      for (const jf of jobFacts) {
        const job = batch[jf.index];
        if (!job) continue;
        const { score, reason, missingSkills } = calculateScore(candidate, jf);
        allScored.push({ ...job, match: score, reason, missingSkills });
        scoredIndices.add(jf.index);
      }

      // Fallback for any the LLM missed
      batch.forEach((job, i) => {
        if (!scoredIndices.has(i)) {
          allScored.push({ ...job, match: 50, reason: 'Could not fully analyse this listing.', missingSkills: [] });
        }
      });

    } catch (err) {
      console.error('match-and-score batch error:', err.message);
      batch.forEach(job => allScored.push({ ...job, match: 50, reason: 'Scoring unavailable.', missingSkills: [] }));
    }
  }

  // ── Filter out poor matches, sort best first ─────────────────────────────
  const qualified = allScored.filter(j => j.match >= MIN_SCORE);
  qualified.sort((a, b) => b.match - a.match);

  console.log(
    `match-and-score: ${jobs.length} in → ${allScored.length} scored → ${qualified.length} above ${MIN_SCORE}% threshold`
  );
  console.log('Top scores:', qualified.slice(0,8).map(j => `${j.match}% ${j.title?.slice(0,25)}`).join(' | '));

  return res.status(200).json({ scored: qualified });
}
