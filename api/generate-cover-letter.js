// /api/generate-cover-letter.js
 
async function callGroq(prompt) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
      temperature: 0.7
    })
  });
  if (!r.ok) throw new Error(`Groq error: ${r.status}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}
 
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { cv, job } = req.body;
  if (!cv || !job) return res.status(400).json({ error: 'Missing cv or job' });
 
  const prompt = `Write a professional cover letter for this job application.
 
Candidate CV (summary):
${cv.slice(0, 2000)}
 
Job: ${job.title} at ${job.company} (${job.location})
Description: ${job.description?.slice(0, 500)}
 
Write 3 short paragraphs, under 220 words. Be direct and specific — no generic filler.
Opening: mention the specific role and company.
Middle: highlight 2-3 relevant skills from the CV.
Closing: brief call to action.
 
Output only the letter text. Do not include a subject line or salutation header.`;
 
  try {
    const letter = await callGroq(prompt);
    return res.status(200).json({ letter: letter.trim() });
  } catch (e) {
    console.error('cover letter error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
