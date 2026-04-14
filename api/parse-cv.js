// /api/parse-cv.js
// Extracts structured candidate profile from CV (PDF, DOCX, TXT)
// Returns skills list that search-jobs uses for pre-filtering

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

async function callGroq(prompt, maxTokens = 700) {
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cv, role, fileBase64, fileType } = req.body;
  if (!role) return res.status(400).json({ error: 'Missing role' });

  let cvText = '';

  if (fileBase64 && fileType) {
    try {
      cvText = await extractText(fileBase64, fileType);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!cvText || cvText.trim().length < 50) {
      return res.status(400).json({ error: 'Could not extract text from the file. Try saving as PDF or plain text.' });
    }
  } else if (cv && cv.trim().length > 0) {
    cvText = cv.trim();
  } else {
    return res.status(400).json({ error: 'No CV provided.' });
  }

  const prompt = `You are a CV parser. Extract structured information from this CV to help match the candidate to job listings.

TARGET ROLE: ${role}

CV TEXT:
${cvText.slice(0, 8000)}

Extract:
- summary: 2-3 sentence summary covering seniority level, domain, key strengths, and years of experience
- skills: ALL technical and domain skills found — tools, languages, frameworks, methodologies, certifications. Be thorough. Include soft skills only if they are highly specific (e.g. "B2 German" not "teamwork").
- yearsExperience: total professional years (number, estimate if unclear)
- seniority: "junior" | "mid" | "senior" | "lead" | "executive" — infer from experience and titles
- location: city/country if clearly stated, otherwise null
- languages: spoken languages with levels if mentioned (e.g. ["English C2", "Polish native"])

Respond ONLY with JSON — no markdown, no explanation:
{
  "summary": "...",
  "skills": ["skill1", "skill2", ...],
  "yearsExperience": 4,
  "seniority": "mid",
  "location": "Warsaw, Poland",
  "languages": ["English C1", "Polish native"]
}`;

  try {
    const text = await callGroq(prompt, 700);
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      console.error('CV parse error, raw:', text);
      return res.status(502).json({ error: 'Failed to parse CV. Please try again.' });
    }

    return res.status(200).json({
      summary: parsed.summary || '',
      skills: parsed.skills || [],
      yearsExperience: parsed.yearsExperience || 0,
      seniority: parsed.seniority || 'unknown',
      location: parsed.location || null,
      languages: parsed.languages || [],
      searchQuery: role.trim(),
    });

  } catch (err) {
    console.error('parse-cv error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
