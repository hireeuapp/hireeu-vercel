const nodemailer = require('nodemailer');
const { Pool }   = require('pg');

// ── DB connection (Neon Postgres) ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Ensure table exists ──
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id         SERIAL PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      joined_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Nodemailer transporter ──
function getTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ── Confirmation email HTML ──
function buildConfirmationEmail(email) {
  return {
    from: `"HireEU" <${process.env.SMTP_USER}>`,
    to:   email,
    subject: "You're on the HireEU waitlist 🎉",
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style>
    body { margin:0; padding:0; background:#f0f5ff; font-family:Arial,sans-serif; }
    .wrap { max-width:560px; margin:40px auto; background:#fff; border-radius:16px;
            overflow:hidden; box-shadow:0 4px 24px rgba(13,31,60,0.1); }
    .header { background:linear-gradient(135deg,#0d1f3c,#1a4dcc);
              padding:40px 40px 32px; text-align:center; }
    .logo { font-size:28px; font-weight:900; color:#fff; letter-spacing:-0.03em; }
    .logo span { color:#93c5fd; }
    .badge { display:inline-block; background:rgba(255,255,255,0.15);
             color:rgba(255,255,255,0.9); font-size:12px; font-weight:600;
             padding:4px 14px; border-radius:999px; margin-top:12px;
             letter-spacing:0.06em; text-transform:uppercase; }
    .body { padding:36px 40px; }
    .title { font-size:22px; font-weight:700; color:#0d1f3c; margin-bottom:12px; line-height:1.3; }
    .text  { font-size:15px; color:#475569; line-height:1.7; margin-bottom:16px; }
    .highlight { background:#f0f5ff; border-left:3px solid #1a4dcc;
                 border-radius:8px; padding:16px 20px; margin:24px 0; }
    .highlight p { margin:0; font-size:14px; color:#1e293b; line-height:1.6; }
    .highlight strong { color:#1a4dcc; }
    .cta-area { text-align:center; margin:28px 0 8px; }
    .cta-btn { display:inline-block; background:#1a4dcc; color:#fff;
               text-decoration:none; padding:14px 30px; border-radius:10px;
               font-weight:600; font-size:15px; }
    .footer { background:#f8fafc; padding:24px 40px; text-align:center;
              border-top:1px solid #e2e8f0; }
    .footer p { font-size:12px; color:#94a3b8; margin:0; line-height:1.7; }
    @media(max-width:600px){
      .body,.footer{ padding:28px 24px; }
      .header{ padding:32px 24px 28px; }
    }
  </style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="logo">Hire<span>EU</span></div>
    <div class="badge">✦ You're in</div>
  </div>
  <div class="body">
    <h1 class="title">Welcome to the waitlist! 🎉</h1>
    <p class="text">Thanks for signing up. You're now on the early access waitlist for <strong>HireEU</strong> — the AI-powered job assistant built specifically for foreigners navigating the Polish and EU job market.</p>
    <div class="highlight">
      <p>✅ &nbsp;<strong>What happens next:</strong><br/>
      We're putting the finishing touches on HireEU. When we're ready to launch, you'll be among the very first to receive access — completely free for early members.</p>
    </div>
    <p class="text">In the meantime, share it with a fellow foreigner job hunting in Poland. The more of us, the better the product gets.</p>
    <div class="cta-area">
      <a href="${process.env.SITE_URL || 'https://hireeu.vercel.app'}" class="cta-btn">Visit HireEU →</a>
    </div>
  </div>
  <div class="footer">
    <p>You received this because you signed up at HireEU<br/>
    No spam, ever. We take that seriously.<br/>
    © 2026 HireEU</p>
  </div>
</div>
</body>
</html>`,
    text: `Welcome to HireEU!\n\nThanks for signing up. You'll be among the first to get access when we launch.\n\nWe'll email you as soon as we're live.\n\n— The HireEU Team`,
  };
}

// ── Main handler ──
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET → return count
  if (req.method === 'GET') {
    try {
      await ensureTable();
      const { rows } = await pool.query('SELECT COUNT(*) FROM waitlist');
      return res.status(200).json({ count: parseInt(rows[0].count) });
    } catch (err) {
      return res.status(500).json({ message: 'DB error' });
    }
  }

  // POST → add signup
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { email } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Please provide a valid email address.' });
  }

  const normalised = email.trim().toLowerCase();

  try {
    await ensureTable();

    // Insert — will throw on duplicate due to UNIQUE constraint
    await pool.query(
      'INSERT INTO waitlist (email) VALUES ($1)',
      [normalised]
    );

    // Get new count
    const { rows } = await pool.query('SELECT COUNT(*) FROM waitlist');
    const count = parseInt(rows[0].count);

    // Send confirmation email (non-blocking)
    try {
      const transporter = getTransporter();
      await transporter.sendMail(buildConfirmationEmail(normalised));

      // Admin notification
      if (process.env.ADMIN_EMAIL) {
        transporter.sendMail({
          from: `"HireEU System" <${process.env.SMTP_USER}>`,
          to:   process.env.ADMIN_EMAIL,
          subject: `New waitlist signup: ${normalised}`,
          text: `New signup: ${normalised}\nTotal: ${count}\nTime: ${new Date().toISOString()}`,
        }).catch(() => {});
      }
    } catch (emailErr) {
      console.error('Email error (non-fatal):', emailErr.message);
    }

    return res.status(200).json({ message: 'Success', count });

  } catch (err) {
    if (err.code === '23505') {
      // Unique violation = duplicate
      return res.status(409).json({ message: "You're already on the waitlist!" });
    }
    console.error('DB error:', err.message);
    return res.status(500).json({ message: 'Something went wrong. Please try again.' });
  }
}
