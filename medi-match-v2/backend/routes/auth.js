const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getOne, run } = require('../database');

const SECRET = process.env.JWT_SECRET || 'medi_match_secret';

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: 'Username and password required' });

    const user = await getOne('SELECT * FROM users WHERE username = $1', [username]);
    if (!user) return res.status(401).json({ success: false, error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ success: false, error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET, { expiresIn: '8h' });
    res.json({ success: true, token, user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/auth/register (admin only in production — open for demo)
router.post('/register', async (req, res) => {
  try {
    const { username, password, role = 'user', full_name } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: 'Username and password required' });

    const existing = await getOne('SELECT id FROM users WHERE username = $1', [username]);
    if (existing) return res.status(409).json({ success: false, error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 10);
    const id   = uuidv4();
    await run('INSERT INTO users (id,username,password_hash,role,full_name) VALUES ($1,$2,$3,$4,$5)', [id, username, hash, role, full_name || username]);
    res.json({ success: true, message: 'Account created' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;

// ── JWT Middleware (exported separately) ─────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'No token' });
  try {
    req.user = jwt.verify(header.slice(7), SECRET);
    next();
  } catch { res.status(401).json({ success: false, error: 'Invalid token' }); }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ success: false, error: 'Admin only' });
  next();
}

module.exports = router;
module.exports.authMiddleware = authMiddleware;
module.exports.adminOnly      = adminOnly;
