// /api/score-jobs.js
// Step C: AI scoring — one call per job, simple recruiter prompt
// Simple in-memory cache keyed by hash(cv + job_id)

const cache = new Map();

function hashKey(cv, jobId) {
  // Simple hash — good enough for in-process caching
  let h = 0;
  const s = cv.slice(0, 500) + jobId;
  for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
  return h.toString();
}

async function scoreJob(cv, job) {
  const key = hashKey(cv, job.id);
  if (cache.has(key)) return cache.get(key);

  const prompt = `You are a recruiter hiring in Poland.

Candidate CV:
${cv.slice(0, 3000)}

Job title: ${job.title}
Company: ${job.company}
Job description:
${job.description.slice(0, 800)}

Be realistic and critical. Would this candidate likely pass initial screening and get an interview for this specific role?

Return ONLY valid JSON, no markdown:
{"score": <0-100>, "reason": "<one sentence why>", "missing_skills": ["<skill1>", "<skill2>"]}`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.1
      })
    });

    if (!r.ok) throw new Error(`Groq ${r.status}`);
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    const result = {
      ...job,
      score: Math.min(100, Math.max(0, parsed.score || 0)),
      reason: parsed.reason || '',
      missing_skills: parsed.missing_skills || [],
    };

    cache.set(key, result);
    return result;
  } catch (e) {
    console.error('score error for', job.title, e.message);
    return { ...job, score: 0, reason: 'Could not score this job.', missing_skills: [] };
  }
}

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

async function extractText(fileBase64, fileType) {
  const buffer = Buffer.from(fileBase64, 'base64');
  const type = fileType.toLowerCase();
  if (type.includes('pdf')) {
    const pdfParse = require('pdf-parse');
    const result = await pdfParse(buffer);
    return result.text || '';
  }
  if (type.includes('docx') || type.includes('wordprocessingml') || type.includes('word')) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  if (type.includes('text') || type.includes('txt')) {
    return buffer.toString('utf-8');
  }
  throw new Error('Unsupported file type. Please upload a PDF, DOCX, or TXT file.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cv, fileBase64, fileType, jobs } = req.body;
  if (!jobs?.length) return res.status(400).json({ error: 'Missing jobs' });

  let cvText = cv || '';
  if (fileBase64 && fileType) {
    try {
      cvText = await extractText(fileBase64, fileType);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  if (!cvText || cvText.trim().length < 20) return res.status(400).json({ error: 'Missing cv or jobs' });

  // Score all jobs in parallel — Groq free tier is fast enough
  const scored = await Promise.all(jobs.map(job => scoreJob(cvText, job)));

  // Sort by score descending, return top 10
  const top10 = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  console.log('Scores:', top10.map(j => `${j.score} ${j.title?.slice(0,25)}`).join(' | '));
  return res.status(200).json({ results: top10 });
}
