// /api/parse-cv.js

export default async function handler(req, res) {
  try {
    const { cvText } = req.body;

    if (!cvText) {
      return res.status(400).json({ error: "Missing cvText" });
    }

    // ✅ NO parsing, NO skill extraction
    return res.status(200).json({
      cvText
    });

  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
}
