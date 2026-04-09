// /api/generate-cover-letter.js
// Groq free tier: generate cover letter for a specific job

async function callGroq(prompt, maxTokens = 600) {
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
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq error: ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { summary, job } = req.body;
  if (!summary || !job) return res.status(400).json({ error: 'Missing summary or job' });

  const prompt = `Write a professional cover letter for the following job application.

CANDIDATE PROFILE:
${summary}

JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${job.description}

Write a concise, genuine cover letter (3 short paragraphs, under 250 words).
- Opening: express interest and mention the specific role + company
- Middle: highlight 2-3 relevant skills/experiences from the candidate profile
- Closing: brief call to action

Do not use generic filler phrases. Be direct and specific.
Output only the letter text, no subject line, no "Dear Hiring Manager" boilerplate header — start with the first paragraph.`;

  try {
    const letter = await callGroq(prompt, 600);
    return res.status(200).json({ letter: letter.trim() });
  } catch (err) {
    console.error('generate-cover-letter error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
