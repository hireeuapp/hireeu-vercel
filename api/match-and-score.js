// /api/match-and-score.js
// LLM extracts facts only → deterministic scoring in code
// Calibrated so most jobs score 50-70, 75+ is a genuine match

async function callGroq(prompt, maxTokens = 1200) {
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
  const W_SKILLS    = 45; // biggest signal
  const W_EXP       = 30; // years of experience
  const W_SENIORITY = 15; // level match
  const W_FIELD     = 10; // same domain

  let skillScore    = 0;
  let expScore      = 0;
  let seniorScore   = 0;
  let fieldScore    = 0;
  const gaps        = [];
  const strengths   = [];

  // ── Skills (0–45) ──
  const required   = jobFacts.requiredSkills  || [];
  const critical   = jobFacts.criticalSkills  || [];
  const candSkills = (candidate.skills || []).map(s => s.toLowerCase());

  if (required.length > 0) {
    let matched = 0;
    for (const skill of required) {
      const sl = skill.toLowerCase();
      if (candSkills.some(cs => cs.includes(sl) || sl.includes(cs))) matched++;
    }
    const ratio = matched / required.length;
    skillScore = Math.round(ratio * W_SKILLS);
    if (ratio >= 0.7) strengths.push(`${matched}/${required.length} required skills match`);
    else gaps.push(`only ${matched}/${required.length} required skills`);

    // Hard penalty per missing critical skill (−8 each, max −24)
    let critPenalty = 0;
    for (const cs of critical) {
      const csl = cs.toLowerCase();
      if (!candSkills.some(s => s.includes(csl) || csl.includes(s))) {
        critPenalty += 8;
        gaps.push(`missing: ${cs}`);
      }
    }
    skillScore = Math.max(0, skillScore - Math.min(critPenalty, 24));
  } else {
    skillScore = Math.round(W_SKILLS * 0.6); // no info — partial credit
  }

  // ── Experience (0–30) ──
  const yearsReq  = jobFacts.yearsRequired || 0;
  const yearsCand = candidate.yearsExperience || 0;

  if (yearsReq === 0) {
    expScore = Math.round(W_EXP * 0.7); // not specified — give benefit of doubt
  } else {
    const diff = yearsCand - yearsReq;
    if (diff >= 0) {
      expScore = W_EXP; // meets or exceeds
      strengths.push(`${yearsCand}yrs meets ${yearsReq}yr requirement`);
    } else if (diff === -1) {
      expScore = Math.round(W_EXP * 0.75);
    } else if (diff === -2) {
      expScore = Math.round(W_EXP * 0.45);
      gaps.push(`${yearsReq}yrs required, candidate has ~${yearsCand}`);
    } else {
      // More than 2 years short — steep penalty
      expScore = Math.round(W_EXP * 0.15);
      gaps.push(`${yearsReq}yrs required, candidate has ~${yearsCand}`);
    }
  }

  // ── Seniority (0–15) ──
  const seniority = jobFacts.seniorityMatch || 'unknown';
  if (seniority === 'match')          { seniorScore = W_SENIORITY; strengths.push('seniority matches'); }
  else if (seniority === 'stretch')   { seniorScore = Math.round(W_SENIORITY * 0.3); gaps.push('role is senior to candidate'); }
  else if (seniority === 'overqualified') { seniorScore = Math.round(W_SENIORITY * 0.6); }
  else                                { seniorScore = Math.round(W_SENIORITY * 0.6); } // unknown

  // ── Field (0–10) ──
  if (jobFacts.fieldMatch === true)   { fieldScore = W_FIELD; strengths.push('same domain'); }
  else if (jobFacts.fieldMatch === false) { fieldScore = 0; gaps.push('different domain'); }
  else                                { fieldScore = Math.round(W_FIELD * 0.5); }

  const total = Math.min(92, skillScore + expScore + seniorScore + fieldScore);

  // Build reason string
  let reason = '';
  if (gaps.length > 0 && strengths.length > 0) {
    reason = `${strengths[0]}. Gap: ${gaps[0]}.`;
  } else if (gaps.length > 0) {
    reason = `Gaps: ${gaps.slice(0,2).join('; ')}.`;
  } else {
    reason = `Strong fit — ${strengths.slice(0,2).join(', ')}.`;
  }

  return { score: total, reason };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { summary, skills, yearsExperience, jobs } = req.body;
  if (!summary || !jobs?.length) return res.status(400).json({ error: 'Missing summary or jobs' });

  const candidate = { summary, skills: skills || [], yearsExperience: yearsExperience || 0 };

  const jobList = jobs.map((j, i) =>
    `[${i}] ${j.title} at ${j.company} (${j.location})\n${j.description}`
  ).join('\n\n');

  const prompt = `You are a fact extractor for a job matching tool. Extract ONLY facts — do NOT score or judge.

CANDIDATE:
${summary}
Skills: ${(skills || []).join(', ')}
Years of experience: ${yearsExperience || 'unknown'}

For each job listing below, extract:
- yearsRequired: minimum years required (number, 0 if not stated)
- requiredSkills: all skills/tools explicitly required or strongly preferred (list)
- criticalSkills: subset that are clearly non-negotiable (list, can be empty)
- seniorityMatch: "match" | "stretch" | "overqualified" | "unknown"
- fieldMatch: true if same professional field as candidate, false if clearly different, null if unclear

JOB LISTINGS:
${jobList}

Respond ONLY with JSON, no markdown:
{
  "jobs": [
    {
      "index": 0,
      "yearsRequired": 5,
      "requiredSkills": ["automation testing", "playwright", "jira"],
      "criticalSkills": ["automation testing"],
      "seniorityMatch": "stretch",
      "fieldMatch": true
    }
  ]
}`;

  try {
    const text = await callGroq(prompt, 1200);

    let extracted;
    try {
      extracted = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      console.error('Extraction parse error:', text);
      return res.status(502).json({ error: 'Failed to analyse jobs. Please try again.' });
    }

    const jobFacts = extracted.jobs || [];
    const scored = [];
    const scoredIndices = new Set();

    for (const jf of jobFacts) {
      const job = jobs[jf.index];
      if (!job) continue;
      const { score, reason } = calculateScore(candidate, jf);
      scored.push({ ...job, match: score, reason });
      scoredIndices.add(jf.index);
    }

    // Fallback for any jobs the LLM missed
    jobs.forEach((job, i) => {
      if (!scoredIndices.has(i)) {
        scored.push({ ...job, match: 50, reason: 'Could not fully analyse this listing.' });
      }
    });

    return res.status(200).json({ scored });

  } catch (err) {
    console.error('match-and-score error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
