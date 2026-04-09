// /api/match-and-score.js

import crypto from "crypto";

// 🔑 simple in-memory cache (you can replace with DB later)
const cache = new Map();

function hashKey(cvText, jobId) {
  return crypto
    .createHash("md5")
    .update(cvText + jobId)
    .digest("hex");
}

// 🔥 CORE: AI scoring function
async function scoreJob(cvText, job) {
  const cacheKey = hashKey(cvText, job.id || job.url);

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const prompt = `
You are an experienced recruiter hiring in Poland and the European Union.

Candidate CV:
${cvText}

Job description:
${job.description}

Be realistic and critical.

Would this candidate likely pass initial screening and get an interview?

Be strict. Most candidates should score between 40–70.
Only give 80+ if the candidate is a very strong match.

Return ONLY valid JSON:
{
  "score": number from 0 to 100,
  "reason": "short explanation why",
  "missing_skills": ["key missing skills"]
}
`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama3-70b-8192",
        messages: [
          { role: "user", content: prompt }
        ],
        temperature: 0.2,
      }),
    });

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {
        score: 0,
        reason: "Could not parse AI response",
        missing_skills: [],
      };
    }

    cache.set(cacheKey, parsed);
    return parsed;

  } catch (err) {
    return {
      score: 0,
      reason: "AI request failed",
      missing_skills: [],
    };
  }
}

// 🚀 MAIN HANDLER
export default async function handler(req, res) {
  try {
    const { cvText, jobs, targetRole } = req.body;

    if (!cvText || !jobs) {
      return res.status(400).json({ error: "Missing cvText or jobs" });
    }

    // 🧠 STEP 1: SIMPLE FILTER
    const filteredJobs = jobs.filter((job) => {
      if (!job.title) return false;

      return job.title.toLowerCase().includes(targetRole?.toLowerCase() || "");
    });

    // limit to avoid huge AI costs
    const jobsToScore = filteredJobs.slice(0, 30);

    // ⚡ STEP 2: SCORE JOBS (parallel for speed)
    const results = await Promise.all(
      jobsToScore.map(async (job) => {
        const scoreData = await scoreJob(cvText, job);

        return {
          ...job,
          ...scoreData,
        };
      })
    );

    // 🧠 STEP 3: SORT
    results.sort((a, b) => b.score - a.score);

    // 🎯 STEP 4: RETURN TOP 10
    return res.status(200).json(results.slice(0, 10));

  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
}
