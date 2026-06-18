import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { db } from './db/init.mjs';
import Stripe from 'stripe';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { authenticator } from '@otplib/preset-default';
import QRCode from 'qrcode';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PORT       = process.env.PORT || 3000;
const IS_PROD    = process.env.NODE_ENV === 'production';

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.warn('⚠  SESSION_SECRET not set — sessions will reset on server restart. Set it in .env for production.');
}
// Derived secret used for HMAC-based CSRF tokens (never changes within a process)
const CSRF_SECRET = SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const ALLOWED_ORIGIN     = process.env.ALLOWED_ORIGIN || null;
const ADMIN_IP_WHITELIST = process.env.ADMIN_IP_WHITELIST
  ? process.env.ADMIN_IP_WHITELIST.split(',').map(s => s.trim()).filter(Boolean)
  : [];

/* ── Stripe ────────────────────────────────────────────────── */
const stripeConfigured = !!(process.env.STRIPE_SECRET_KEY);
const stripe = stripeConfigured ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/* ── App ───────────────────────────────────────────────────── */
const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

/* ── HTTPS redirect (production behind a reverse proxy) ─────── */
app.use((req, res, next) => {
  if (IS_PROD && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

/* ── Security headers ──────────────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:    ["'self'", "'unsafe-inline'", 'https://js.stripe.com', 'https://cdn.tailwindcss.com', 'https://fonts.googleapis.com', 'https://www.googletagmanager.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:', 'https:', 'blob:'],
      frameSrc:    ['https://js.stripe.com'],
      connectSrc:  ["'self'", 'https://api.stripe.com'],
      objectSrc:   ["'none'"],
      ...(IS_PROD ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  frameguard:     { action: 'deny' },
  noSniff:        true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

/* ── CORS ──────────────────────────────────────────────────── */
app.use((req, res, next) => {
  if (ALLOWED_ORIGIN) {
    const origin = req.headers.origin;
    if (origin === ALLOWED_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ── Stripe webhook needs raw body — must come BEFORE json() ── */
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

/* ── Body parsers (10 kb limit) ────────────────────────────── */
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

/* ── Session ───────────────────────────────────────────────── */
app.use(session({
  secret:           SESSION_SECRET || CSRF_SECRET,
  resave:           false,
  saveUninitialized: false,
  name:             'ctd.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure:   IS_PROD,
    maxAge:   30 * 60 * 1000,
  },
}));

/* ── Session inactivity timeout (30 min) ───────────────────── */
app.use((req, res, next) => {
  if (req.session?.adminLoggedIn) {
    const now = Date.now();
    if (req.session.lastActivity && now - req.session.lastActivity > 30 * 60 * 1000) {
      return req.session.destroy(() => {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' });
        res.redirect('/admin/login');
      });
    }
    req.session.lastActivity = now;
  }
  next();
});

/* ── Rate limiters ─────────────────────────────────────────── */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many submissions. Try again later.' },
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Rate limit exceeded. Try again shortly.' },
  skip: (req) => req.path === '/api/webhooks/stripe',
});

app.use('/api/', apiLimiter);

/* ── CSRF (HMAC-based, derived from session ID) ─────────────── */
function generateCsrfToken(sessionId) {
  return crypto.createHmac('sha256', CSRF_SECRET).update(sessionId).digest('hex');
}

function verifyCsrf(token, sessionId) {
  try {
    const expected = generateCsrfToken(sessionId);
    const tBuf = Buffer.from(token,    'hex');
    const eBuf = Buffer.from(expected, 'hex');
    if (tBuf.length !== eBuf.length) return false;
    return crypto.timingSafeEqual(tBuf, eBuf);
  } catch { return false; }
}

/* ── Unsubscribe token (stateless HMAC — no DB row needed) ── */
function generateUnsubscribeToken(email) {
  return crypto.createHmac('sha256', CSRF_SECRET)
    .update(`unsubscribe:${email.toLowerCase().trim()}`)
    .digest('hex');
}

/* ── Security event logger ─────────────────────────────────── */
function logSecurity(event_type, req, details = '') {
  try {
    const ip       = req.ip || req.socket?.remoteAddress || '';
    const username = req.session?.adminUsername || (typeof req.body?.username === 'string' ? req.body.username : '') || '';
    db.prepare('INSERT INTO security_log (event_type,ip,username,details) VALUES (?,?,?,?)').run(event_type, ip, username, details);
  } catch { /* never throw from logger */ }
}

/* ── Admin IP whitelist ────────────────────────────────────── */
function ipWhitelistCheck(req, res, next) {
  if (!ADMIN_IP_WHITELIST.length) return next();
  const clientIp = req.ip || req.socket?.remoteAddress || '';
  if (ADMIN_IP_WHITELIST.includes(clientIp)) return next();
  logSecurity('ip_blocked', req, `${clientIp} blocked from admin`);
  return res.status(403).send('Access denied');
}

/* ── Auth middleware ───────────────────────────────────────── */
function requireAuth(req, res, next) {
  if (!req.session?.adminLoggedIn) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/admin/login');
  }
  // CSRF enforcement on state-changing methods
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const token = req.headers['x-csrf-token'];
    if (!token || !verifyCsrf(token, req.sessionID)) {
      logSecurity('csrf_invalid', req, req.path);
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
  }
  next();
}

/* ── RBAC middleware ───────────────────────────────────────── */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.adminLoggedIn) {
      return req.path.startsWith('/api/')
        ? res.status(401).json({ error: 'Unauthorized' })
        : res.redirect('/admin/login');
    }
    if (!roles.includes(req.session.adminRole)) {
      logSecurity('forbidden', req, `Role ${req.session.adminRole} tried ${req.path}`);
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/* ── File upload ───────────────────────────────────────────── */
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const ALLOWED_MIME = new Set(['image/jpeg','image/png','image/webp','image/gif','image/svg+xml','video/mp4','video/webm','application/pdf']);
const ALLOWED_EXT  = new Set(['.jpg','.jpeg','.png','.webp','.gif','.svg','.mp4','.webm','.pdf']);
const VIDEO_EXT    = new Set(['.mp4','.webm']);
const MAX_IMAGE    = 10 * 1024 * 1024;  // 10 MB
const MAX_VIDEO    = 100 * 1024 * 1024; // 100 MB

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_VIDEO },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext) || !ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('File type not allowed'));
    }
    // Enforce per-type size limit at filter time using content-length header
    const cl = parseInt(req.headers['content-length'] || '0');
    if (!VIDEO_EXT.has(ext) && cl > MAX_IMAGE) {
      return cb(new Error('Image files may not exceed 10 MB'));
    }
    cb(null, true);
  },
});

/* ── Static ────────────────────────────────────────────────── */
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(__dirname, { index: false }));

/* ── Input helpers ─────────────────────────────────────────── */
const sanitize = (str, max = 255) => (typeof str === 'string' ? str.slice(0, max).trim() : '');
const isEmail  = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
const isPhone  = (s) => !s || /^[\d\s+\-()]{0,20}$/.test(s);

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 12)   return 'Password must be at least 12 characters';
  if (!/[A-Z]/.test(pw))                           return 'Must include an uppercase letter';
  if (!/[a-z]/.test(pw))                           return 'Must include a lowercase letter';
  if (!/[0-9]/.test(pw))                           return 'Must include a number';
  if (!/[^A-Za-z0-9]/.test(pw))                   return 'Must include a special character';
  return null;
}

function checkBreachedPassword(password) {
  return new Promise((resolve) => {
    try {
      const hash   = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
      const prefix = hash.slice(0, 5);
      const suffix = hash.slice(5);
      const req = https.get(
        `https://api.pwnedpasswords.com/range/${prefix}`,
        { headers: { 'User-Agent': 'ClearTorque-Admin' } },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve(data.split('\n').some((l) => l.toUpperCase().startsWith(suffix))));
        }
      );
      req.on('error', () => resolve(false));
      req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}

/* ═══════════════════════════════════════════════════════════
   CSRF TOKEN ENDPOINT
═══════════════════════════════════════════════════════════ */
app.get('/api/auth/csrf', (req, res) => {
  // Ensure session is persisted so the cookie is set and sessionID stays stable
  if (!req.session.csrfReady) req.session.csrfReady = true;
  res.json({ token: generateCsrfToken(req.sessionID) });
});

/* ═══════════════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════════════ */
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  // CSRF check (login page fetches token before submitting)
  const csrfHeader = req.headers['x-csrf-token'];
  if (!csrfHeader || !verifyCsrf(csrfHeader, req.sessionID)) {
    return res.status(403).json({ error: 'Invalid request' });
  }

  const username = sanitize(req.body?.username, 100);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM admin_users WHERE username=?').get(username);
  if (!user) {
    logSecurity('failed_login', req, `Unknown user: ${username}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Account lockout check
  if (user.lockout_until) {
    const lockoutMs = new Date(user.lockout_until).getTime();
    if (Date.now() < lockoutMs) {
      const mins = Math.ceil((lockoutMs - Date.now()) / 60000);
      logSecurity('login_blocked', req, username);
      return res.status(429).json({ error: `Account locked. Try again in ${mins} minute(s).` });
    }
    db.prepare('UPDATE admin_users SET failed_login_count=?, lockout_until=? WHERE id=?').run(0, '', user.id);
  }

  const passwordOk = await bcrypt.compare(password, user.password_hash);
  if (!passwordOk) {
    const count = (user.failed_login_count || 0) + 1;
    if (count >= 5) {
      const until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      db.prepare('UPDATE admin_users SET failed_login_count=?, lockout_until=? WHERE id=?').run(count, until, user.id);
      logSecurity('account_locked', req, username);
      return res.status(429).json({ error: 'Account locked after 5 failed attempts. Try again in 15 minutes.' });
    }
    db.prepare('UPDATE admin_users SET failed_login_count=? WHERE id=?').run(count, user.id);
    logSecurity('failed_login', req, `${username} (attempt ${count}/5)`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Reset failed attempts
  db.prepare('UPDATE admin_users SET failed_login_count=?, lockout_until=? WHERE id=?').run(0, '', user.id);

  // Require 2FA if enabled
  if (user.totp_enabled) {
    req.session.totpPending = true;
    req.session.totpUserId  = user.id;
    return res.json({ ok: true, requireTotp: true });
  }

  // Complete login — regenerate session to prevent fixation
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Login error' });
    req.session.adminLoggedIn  = true;
    req.session.adminRole      = user.role;
    req.session.adminUsername  = user.username;
    req.session.lastActivity   = Date.now();
    db.prepare('UPDATE admin_users SET last_login=? WHERE id=?').run(new Date().toISOString(), user.id);
    logSecurity('login_success', req, username);
    res.json({ ok: true });
  });
});

app.post('/api/auth/logout', (req, res) => {
  logSecurity('logout', req, req.session?.adminUsername || '');
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.adminLoggedIn) return res.json({ loggedIn: false });
  const user = db.prepare('SELECT username, role, totp_enabled, last_login FROM admin_users WHERE username=?')
    .get(req.session.adminUsername);
  res.json({
    loggedIn:    true,
    username:    req.session.adminUsername,
    role:        req.session.adminRole,
    lastLogin:   user?.last_login || '',
    totpEnabled: !!(user?.totp_enabled),
  });
});

/* ── 2FA / TOTP ─────────────────────────────────────────────── */
app.post('/api/auth/totp/verify', loginLimiter, (req, res) => {
  if (!req.session?.totpPending || !req.session?.totpUserId) {
    return res.status(400).json({ error: 'No pending 2FA verification' });
  }
  const token = sanitize(req.body?.token, 10).replace(/\s/g, '');
  if (!token) return res.status(400).json({ error: 'Authenticator code required' });

  const user = db.prepare('SELECT * FROM admin_users WHERE id=?').get(req.session.totpUserId);
  if (!user) return res.status(400).json({ error: 'Invalid session' });

  const valid = authenticator.verify({ token, secret: user.totp_secret });
  if (!valid) {
    logSecurity('totp_failed', req, user.username);
    return res.status(401).json({ error: 'Invalid authenticator code' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Login error' });
    req.session.adminLoggedIn = true;
    req.session.adminRole     = user.role;
    req.session.adminUsername = user.username;
    req.session.lastActivity  = Date.now();
    db.prepare('UPDATE admin_users SET last_login=?, failed_login_count=0 WHERE id=?').run(new Date().toISOString(), user.id);
    logSecurity('login_success_2fa', req, user.username);
    res.json({ ok: true });
  });
});

app.get('/api/auth/totp/setup', requireAuth, (req, res) => {
  const secret      = authenticator.generateSecret();
  const otpauthUrl  = authenticator.keyuri(req.session.adminUsername, 'Clean Torque Admin', secret);
  req.session.totpSetupSecret = secret;
  QRCode.toDataURL(otpauthUrl, (err, qrDataUrl) => {
    res.json({ secret, otpauthUrl, qrDataUrl: err ? null : qrDataUrl });
  });
});

app.post('/api/auth/totp/enable', requireAuth, (req, res) => {
  const secret = req.session.totpSetupSecret;
  if (!secret) return res.status(400).json({ error: 'Start setup first: GET /api/auth/totp/setup' });
  const token = sanitize(req.body?.token, 10).replace(/\s/g, '');
  if (!authenticator.verify({ token, secret })) {
    return res.status(401).json({ error: 'Invalid code — scan the QR code again and enter a fresh 6-digit code' });
  }
  db.prepare('UPDATE admin_users SET totp_secret=?, totp_enabled=1 WHERE username=?').run(secret, req.session.adminUsername);
  delete req.session.totpSetupSecret;
  logSecurity('totp_enabled', req, req.session.adminUsername);
  res.json({ ok: true });
});

app.post('/api/auth/totp/disable', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM admin_users WHERE username=?').get(req.session.adminUsername);
  const ok   = await bcrypt.compare(req.body?.password || '', user?.password_hash || '');
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });
  db.prepare('UPDATE admin_users SET totp_secret=?, totp_enabled=0 WHERE username=?').run('', req.session.adminUsername);
  logSecurity('totp_disabled', req, req.session.adminUsername);
  res.json({ ok: true });
});

/* ── Change password (dedicated endpoint) ───────────────────── */
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  const user = db.prepare('SELECT * FROM admin_users WHERE username=?').get(req.session.adminUsername);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!(await bcrypt.compare(current_password || '', user.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const pwError = validatePassword(new_password || '');
  if (pwError) return res.status(400).json({ error: pwError });

  const breached = await checkBreachedPassword(new_password);
  if (breached) return res.status(400).json({ error: 'This password has appeared in a data breach. Choose a different one.' });

  const hash = await bcrypt.hash(new_password, 12);
  db.prepare('UPDATE admin_users SET password_hash=? WHERE username=?').run(hash, req.session.adminUsername);
  logSecurity('password_changed', req, req.session.adminUsername);
  res.json({ ok: true });
});

/* ── Security log (super_admin only) ───────────────────────── */
app.get('/api/admin/security-log', requireAuth, requireRole('super_admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM security_log ORDER BY created_at DESC LIMIT 200').all();
  res.json(rows);
});

/* ═══════════════════════════════════════════════════════════
   ADMIN PAGES
═══════════════════════════════════════════════════════════ */
app.get('/admin',           (req, res) => res.redirect(req.session?.adminLoggedIn ? '/admin/dashboard' : '/admin/login'));
app.get('/admin/login',     (req, res) => {
  if (req.session?.adminLoggedIn) return res.redirect('/admin/dashboard');
  res.sendFile(path.join(__dirname, 'admin', 'login.html'));
});
app.get('/admin/dashboard', ipWhitelistCheck, requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

/* ═══════════════════════════════════════════════════════════
   API: PACKAGES
═══════════════════════════════════════════════════════════ */
app.get('/api/packages', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rows = db.prepare('SELECT * FROM packages WHERE visible=1 ORDER BY sort_order ASC, id ASC').all();
  res.json(rows);
});

app.get('/api/packages/all', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rows = db.prepare('SELECT * FROM packages ORDER BY sort_order ASC, id ASC').all();
  res.json(rows);
});

app.post('/api/packages', requireAuth, requireRole('super_admin', 'editor'), (req, res) => {
  const name  = sanitize(req.body?.name, 100);
  const price = parseInt(req.body?.price) || 0;
  const about = sanitize(req.body?.about || '', 2000);
  const visible = req.body?.visible ?? 1;
  if (!name) return res.status(400).json({ error: 'Package name required' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM packages').get().m;
  const sort_order = Number.isInteger(maxOrder) ? maxOrder + 1 : 0;
  const result = db.prepare('INSERT INTO packages (name,price,about,visible,sort_order) VALUES (?,?,?,?,?)')
    .run(name, price, about, visible ? 1 : 0, sort_order);
  logSecurity('admin_action', req, `package ${result.lastInsertRowid} created`);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.put('/api/packages/:id', requireAuth, requireRole('super_admin', 'editor'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const name  = sanitize(req.body?.name, 100);
  const price = parseInt(req.body?.price) || 0;
  const about = sanitize(req.body?.about || '', 2000);
  const visible = req.body?.visible ?? 1;
  if (!name) return res.status(400).json({ error: 'Package name required' });
  db.prepare('UPDATE packages SET name=?,price=?,about=?,visible=? WHERE id=?')
    .run(name, price, about, visible ? 1 : 0, id);
  logSecurity('admin_action', req, `package ${id} updated`);
  res.json({ ok: true });
});

app.delete('/api/packages/:id', requireAuth, requireRole('super_admin', 'editor'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  db.prepare('DELETE FROM packages WHERE id=?').run(id);
  logSecurity('admin_action', req, `package ${id} deleted`);
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   API: BOOKINGS
═══════════════════════════════════════════════════════════ */
app.get('/api/bookings', requireAuth, (req, res) => {
  const { status, search } = req.query;
  let q = 'SELECT * FROM bookings';
  const params = [], where = [];
  if (status && status !== 'all') { where.push('status=?'); params.push(sanitize(status, 20)); }
  if (search) {
    where.push('(name LIKE ? OR email LIKE ? OR vehicle_make LIKE ? OR vehicle_model LIKE ?)');
    params.push(...Array(4).fill(`%${sanitize(search, 100)}%`));
  }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY created_at DESC';
  res.json(db.prepare(q).all(...params).map(r => ({ ...r, addons: JSON.parse(r.addons || '[]') })));
});

app.post('/api/bookings', contactLimiter, (req, res) => {
  const name              = sanitize(req.body?.name,   100);
  const email             = sanitize(req.body?.email,  254);
  const phone             = sanitize(req.body?.phone,   20);
  const make              = sanitize(req.body?.vehicle_make,  50);
  const model             = sanitize(req.body?.vehicle_model, 50);
  const tier              = sanitize(req.body?.tier,   20);
  const freq              = parseInt(req.body?.frequency) || 0;
  const addons            = Array.isArray(req.body?.addons) ? req.body.addons.map(a => sanitize(String(a), 50)) : [];
  const date              = sanitize(req.body?.preferred_date, 20);
  const marketingConsent  = req.body?.marketing_consent ? 1 : 0;
  const consentAt         = marketingConsent ? new Date().toISOString() : '';

  if (!name || !email)        return res.status(400).json({ error: 'Name and email required' });
  if (!isEmail(email))        return res.status(400).json({ error: 'Invalid email address' });
  if (!isPhone(phone))        return res.status(400).json({ error: 'Invalid phone number' });

  const result = db.prepare(
    'INSERT INTO bookings (name,email,phone,vehicle_make,vehicle_model,tier,frequency,addons,preferred_date,marketing_consent,marketing_consent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(name, email, phone, make, model, tier, freq, JSON.stringify(addons), date, marketingConsent, consentAt);

  if (marketingConsent) {
    db.prepare('INSERT INTO consent_log (customer_email,consent_type,given,source) VALUES (?,?,?,?)').run(email, 'marketing_email', 1, 'booking_form');
  }

  res.json({ ok: true, id: result.lastInsertRowid });
});

app.put('/api/bookings/:id', requireAuth, requireRole('super_admin', 'editor'), (req, res) => {
  const id     = parseInt(req.params.id);
  const status = sanitize(req.body?.status, 30);
  const notes  = sanitize(req.body?.notes, 1000);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  db.prepare('UPDATE bookings SET status=?,notes=? WHERE id=?').run(status, notes, id);
  logSecurity('admin_action', req, `booking ${id} updated → ${status}`);
  res.json({ ok: true });
});

app.delete('/api/bookings/:id', requireAuth, requireRole('super_admin'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  db.prepare('DELETE FROM bookings WHERE id=?').run(id);
  logSecurity('admin_action', req, `booking ${id} deleted`);
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   API: CONTACTS
═══════════════════════════════════════════════════════════ */
app.get('/api/contacts', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM contacts ORDER BY created_at DESC').all());
});

app.post('/api/contacts', contactLimiter, (req, res) => {
  const name             = sanitize(req.body?.name,    100);
  const email            = sanitize(req.body?.email,   254);
  const phone            = sanitize(req.body?.phone,    20);
  const message          = sanitize(req.body?.message, 2000);
  const marketingConsent = req.body?.marketing_consent ? 1 : 0;
  const consentAt        = marketingConsent ? new Date().toISOString() : '';

  if (!name || !email || !message) return res.status(400).json({ error: 'Required fields missing' });
  if (!isEmail(email))             return res.status(400).json({ error: 'Invalid email address' });
  if (!isPhone(phone))             return res.status(400).json({ error: 'Invalid phone number' });

  db.prepare('INSERT INTO contacts (name,email,phone,message,marketing_consent,marketing_consent_at) VALUES (?,?,?,?,?,?)').run(name, email, phone, message, marketingConsent, consentAt);

  if (marketingConsent) {
    db.prepare('INSERT INTO consent_log (customer_email,consent_type,given,source) VALUES (?,?,?,?)').run(email, 'marketing_email', 1, 'contact_form');
  }

  res.json({ ok: true });
});

app.delete('/api/contacts/:id', requireAuth, requireRole('super_admin', 'editor'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  db.prepare('DELETE FROM contacts WHERE id=?').run(id);
  logSecurity('admin_action', req, `contact ${id} deleted`);
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   API: SETTINGS
═══════════════════════════════════════════════════════════ */
app.get('/api/settings', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rows = db.prepare("SELECT key,value FROM settings WHERE key NOT IN ('admin_username','admin_password')").all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

const PUBLIC_SETTING_KEYS = new Set([
  'instagram_url','facebook_url','tiktok_url','twitter_url','youtube_url','phone','email','address',
  'hero_tag','hero_headline','hero_sub','hero_cta1_text','hero_cta1_link','hero_cta2_text','hero_cta2_link',
  'hero_bg_url','hero_tag_color','hero_headline_color','hero_accent_color','hero_sub_color',
  'hero_show','hero_padding_top','hero_overlay_opacity',
  'slideshow_transition','slideshow_interval','slideshow_autoplay','slideshow_dots','slideshow_arrows','slideshow_enabled',
  'global_heading_font','global_body_font','global_brand_color','global_body_color','global_heading_color',
  'global_body_size','global_body_line_height','global_heading_letter_spacing','global_btn_radius',
  'nav_show','nav_logo_text','nav_logo_sub','nav_cta_text','nav_cta_link','nav_bg_color',
  'stats_show','stat1_num','stat1_label','stat2_num','stat2_label','stat3_num','stat3_label','stat4_num','stat4_label',
  'stats_num_color','stats_label_color','stats_bg_color','stats_padding_top','stats_padding_bottom',
  'packages_show','packages_title','packages_sub','packages_title_color','packages_bg_color','packages_padding_top','packages_padding_bottom',
  'booking_show','booking_title','booking_sub','booking_title_color','booking_bg_color','booking_padding_top','booking_padding_bottom',
  'gallery_show','gallery_title','gallery_sub','gallery_title_color','gallery_bg_color','gallery_padding_top','gallery_padding_bottom',
  'contact_show','contact_title','contact_sub','contact_title_color','contact_bg_color','contact_padding_top','contact_padding_bottom',
  'footer_show','footer_tagline','footer_copyright','footer_bg_color',
]);

app.put('/api/settings', requireAuth, requireRole('super_admin', 'editor'), (req, res) => {
  const upd = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  db.transaction(() => {
    for (const [k, v] of Object.entries(req.body)) {
      if (PUBLIC_SETTING_KEYS.has(k)) upd.run(k, sanitize(String(v), 2000));
    }
  })();
  logSecurity('admin_action', req, 'settings updated');
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   API: MEDIA
═══════════════════════════════════════════════════════════ */
app.get('/api/media', (req, res) => {
  res.json(db.prepare('SELECT * FROM media ORDER BY sort_order ASC, id DESC').all());
});

app.post('/api/media', requireAuth, requireRole('super_admin', 'editor'), upload.single('file'), (req, res) => {
  const type       = sanitize(req.body?.type || 'photo', 10);
  const url        = sanitize(req.body?.url || '', 500);
  const label      = sanitize(req.body?.label || '', 200);
  const vehicle    = sanitize(req.body?.vehicle || '', 100);
  const sort_order = parseInt(req.body?.sort_order) || 0;
  const alt_text   = sanitize(req.body?.alt_text || '', 300);
  const section    = sanitize(req.body?.section || '', 50);
  const caption    = sanitize(req.body?.caption || '', 500);
  const file_size  = req.file?.size || 0;

  const filename = req.file?.filename ?? '';
  const fileUrl  = filename ? `/uploads/${filename}` : url;
  if (!fileUrl) return res.status(400).json({ error: 'No file or URL provided' });

  const result = db.prepare(
    'INSERT INTO media (type,filename,url,label,vehicle,sort_order,alt_text,section,file_size,caption) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(type, filename, fileUrl, label, vehicle, sort_order, alt_text, section, file_size, caption);
  logSecurity('admin_action', req, `media ${result.lastInsertRowid} uploaded`);
  res.json({ ok: true, id: result.lastInsertRowid, url: fileUrl });
});

app.put('/api/media/:id', requireAuth, requireRole('super_admin', 'editor'), (req, res) => {
  const id         = parseInt(req.params.id);
  const label      = sanitize(req.body?.label || '', 200);
  const vehicle    = sanitize(req.body?.vehicle || '', 100);
  const sort_order = parseInt(req.body?.sort_order) || 0;
  const alt_text   = sanitize(req.body?.alt_text || '', 300);
  const caption    = sanitize(req.body?.caption || '', 500);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  db.prepare('UPDATE media SET label=?,vehicle=?,sort_order=?,alt_text=?,caption=? WHERE id=?')
    .run(label, vehicle, sort_order, alt_text, caption, id);
  res.json({ ok: true });
});

app.delete('/api/media/:id', requireAuth, requireRole('super_admin', 'editor'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const row = db.prepare('SELECT filename FROM media WHERE id=?').get(id);
  if (row?.filename) {
    const fp = path.join(uploadsDir, row.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM media WHERE id=?').run(id);
  logSecurity('admin_action', req, `media ${id} deleted`);
  res.json({ ok: true });
});

app.post('/api/media/reorder', requireAuth, requireRole('super_admin', 'editor'), (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const upd = db.prepare('UPDATE media SET sort_order=? WHERE id=?');
  db.transaction(() => { ids.forEach((id, i) => upd.run(i, parseInt(id))); })();
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   API: SLIDES (hero slideshow)
═══════════════════════════════════════════════════════════ */
app.get('/api/slides', (req, res) => {
  res.json(db.prepare('SELECT * FROM slides WHERE visible=1 ORDER BY sort_order ASC, id ASC').all());
});

app.get('/api/slides/all', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM slides ORDER BY sort_order ASC, id ASC').all());
});

app.post('/api/slides', requireAuth, requireRole('super_admin', 'editor'), upload.single('file'), (req, res) => {
  const headline        = sanitize(req.body?.headline || '', 500);
  const sub             = sanitize(req.body?.sub || '', 1000);
  const cta1_text       = sanitize(req.body?.cta1_text || '', 100);
  const cta1_link       = sanitize(req.body?.cta1_link || '', 500);
  const cta2_text       = sanitize(req.body?.cta2_text || '', 100);
  const cta2_link       = sanitize(req.body?.cta2_link || '', 500);
  const overlay_color   = sanitize(req.body?.overlay_color || '#000000', 20);
  const overlay_opacity = parseFloat(req.body?.overlay_opacity) || 0.5;
  const sort_order      = parseInt(req.body?.sort_order) || 0;
  const visible         = req.body?.visible === '0' ? 0 : 1;
  const video_url       = sanitize(req.body?.video_url || '', 500);
  const image_url       = req.file ? `/uploads/${req.file.filename}` : sanitize(req.body?.image_url || '', 500);

  const result = db.prepare(
    'INSERT INTO slides (headline,sub,cta1_text,cta1_link,cta2_text,cta2_link,image_url,video_url,overlay_color,overlay_opacity,sort_order,visible) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(headline, sub, cta1_text, cta1_link, cta2_text, cta2_link, image_url, video_url, overlay_color, overlay_opacity, sort_order, visible);
  logSecurity('admin_action', req, `slide ${result.lastInsertRowid} created`);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.put('/api/slides/:id', requireAuth, requireRole('super_admin', 'editor'), upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const headline        = sanitize(req.body?.headline || '', 500);
  const sub             = sanitize(req.body?.sub || '', 1000);
  const cta1_text       = sanitize(req.body?.cta1_text || '', 100);
  const cta1_link       = sanitize(req.body?.cta1_link || '', 500);
  const cta2_text       = sanitize(req.body?.cta2_text || '', 100);
  const cta2_link       = sanitize(req.body?.cta2_link || '', 500);
  const overlay_color   = sanitize(req.body?.overlay_color || '#000000', 20);
  const overlay_opacity = parseFloat(req.body?.overlay_opacity) || 0.5;
  const visible         = req.body?.visible === '0' ? 0 : 1;
  const video_url       = sanitize(req.body?.video_url || '', 500);
  let image_url         = sanitize(req.body?.image_url || '', 500);

  if (req.file) {
    const old = db.prepare('SELECT image_url FROM slides WHERE id=?').get(id);
    if (old?.image_url?.startsWith('/uploads/')) {
      const fp = path.join(uploadsDir, path.basename(old.image_url));
      if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch {} }
    }
    image_url = `/uploads/${req.file.filename}`;
  }

  db.prepare('UPDATE slides SET headline=?,sub=?,cta1_text=?,cta1_link=?,cta2_text=?,cta2_link=?,image_url=?,video_url=?,overlay_color=?,overlay_opacity=?,visible=? WHERE id=?')
    .run(headline, sub, cta1_text, cta1_link, cta2_text, cta2_link, image_url, video_url, overlay_color, overlay_opacity, visible, id);
  logSecurity('admin_action', req, `slide ${id} updated`);
  res.json({ ok: true });
});

app.delete('/api/slides/:id', requireAuth, requireRole('super_admin', 'editor'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const row = db.prepare('SELECT image_url FROM slides WHERE id=?').get(id);
  if (row?.image_url?.startsWith('/uploads/')) {
    const fp = path.join(uploadsDir, path.basename(row.image_url));
    if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch {} }
  }
  db.prepare('DELETE FROM slides WHERE id=?').run(id);
  logSecurity('admin_action', req, `slide ${id} deleted`);
  res.json({ ok: true });
});

app.post('/api/slides/reorder', requireAuth, requireRole('super_admin', 'editor'), (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const upd = db.prepare('UPDATE slides SET sort_order=? WHERE id=?');
  db.transaction(() => { ids.forEach((id, i) => upd.run(i, parseInt(id))); })();
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   API: DASHBOARD
═══════════════════════════════════════════════════════════ */
app.get('/api/dashboard', requireAuth, (req, res) => {
  const now        = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const totalThisMonth = db.prepare('SELECT COUNT(*) as c FROM bookings WHERE created_at >= ?').get(monthStart).c;
  const pending        = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status='Pending'").get().c;
  const confirmed      = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status='Confirmed'").get().c;
  const completed      = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status='Completed'").get().c;
  const popularRow     = db.prepare("SELECT tier,COUNT(*) as c FROM bookings WHERE tier!='' GROUP BY tier ORDER BY c DESC LIMIT 1").get();
  const recent         = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 6').all();
  const contacts       = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
  const recentEvents   = db.prepare('SELECT event_type,ip,username,created_at FROM security_log ORDER BY created_at DESC LIMIT 10').all();

  res.json({
    totalThisMonth, pending, confirmed, completed,
    popularPackage:  popularRow ? popularRow.tier.charAt(0).toUpperCase() + popularRow.tier.slice(1) : '—',
    recentBookings:  recent.map(r => ({ ...r, addons: JSON.parse(r.addons || '[]') })),
    contacts,
    recentEvents,
  });
});

/* ═══════════════════════════════════════════════════════════
   STRIPE WEBHOOK (raw body already applied above)
═══════════════════════════════════════════════════════════ */
function handleStripeWebhook(req, res) {
  if (!stripeConfigured) return res.status(400).json({ error: 'Stripe not configured' });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logSecurity('webhook_invalid', req, err.message);
    return res.status(400).json({ error: 'Webhook signature invalid' });
  }

  const data = event.data.object;

  if (event.type === 'checkout.session.completed') {
    const meta  = data.metadata || {};
    const subId = data.subscription;
    const custId = data.customer;
    if (meta.package_id && data.mode === 'subscription') {
      const pkg = db.prepare('SELECT * FROM sub_packages WHERE id=?').get(meta.package_id);
      const existingSub = subId ? db.prepare('SELECT id FROM subscribers WHERE stripe_sub_id=?').get(subId) : null;
      if (!existingSub) {
        const next = new Date(); next.setMonth(next.getMonth() + 1);
        db.prepare('INSERT INTO subscribers (name,email,package_id,package_name,stripe_customer_id,stripe_sub_id,status,next_payment_date) VALUES (?,?,?,?,?,?,?,?)').run(
          meta.customer_name || '', meta.customer_email || data.customer_email || '', meta.package_id, pkg?.name || '', custId || '', subId || '', 'Active', next.toISOString().slice(0,10)
        );
      }
    }
    logSecurity('payment_event', req, `checkout.session.completed: ${data.id}`);
  }

  if (event.type === 'invoice.payment_succeeded') {
    const sub = data.subscription ? db.prepare('SELECT * FROM subscribers WHERE stripe_sub_id=?').get(data.subscription) : null;
    if (sub) {
      const next = new Date(); next.setMonth(next.getMonth() + 1);
      db.prepare('UPDATE subscribers SET status=?,next_payment_date=? WHERE id=?').run('Active', next.toISOString().slice(0,10), sub.id);
      db.prepare('INSERT INTO payment_history (subscriber_id,customer_name,customer_email,package_name,amount_pence,currency,status,stripe_payment_id) VALUES (?,?,?,?,?,?,?,?)').run(
        sub.id, sub.name, sub.email, sub.package_name, data.amount_paid || 0, data.currency || 'gbp', 'Paid', data.payment_intent || ''
      );
      logSecurity('payment_event', req, `payment_succeeded: ${data.payment_intent}`);
    }
  }

  if (event.type === 'invoice.payment_failed') {
    const sub = data.subscription ? db.prepare('SELECT * FROM subscribers WHERE stripe_sub_id=?').get(data.subscription) : null;
    if (sub) {
      db.prepare('UPDATE subscribers SET status=? WHERE id=?').run('Failed', sub.id);
      db.prepare('INSERT INTO payment_history (subscriber_id,customer_name,customer_email,package_name,amount_pence,currency,status,stripe_payment_id) VALUES (?,?,?,?,?,?,?,?)').run(
        sub.id, sub.name, sub.email, sub.package_name, data.amount_due || 0, data.currency || 'gbp', 'Failed', data.payment_intent || ''
      );
      logSecurity('payment_event', req, `payment_failed: ${data.payment_intent}`);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    db.prepare("UPDATE subscribers SET status='Cancelled' WHERE stripe_sub_id=?").run(data.id);
    logSecurity('payment_event', req, `subscription cancelled: ${data.id}`);
  }

  res.json({ received: true });
}

/* ═══════════════════════════════════════════════════════════
   API: STRIPE CONFIG (public key only)
═══════════════════════════════════════════════════════════ */
app.get('/api/stripe-config', (req, res) => {
  res.json({ configured: stripeConfigured, publicKey: process.env.STRIPE_PUBLIC_KEY || '' });
});

/* ═══════════════════════════════════════════════════════════
   API: SUBSCRIPTION PACKAGES (public)
═══════════════════════════════════════════════════════════ */
app.get('/api/sub-packages', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rows = db.prepare('SELECT * FROM sub_packages WHERE visible=1 ORDER BY sort_order ASC, id ASC').all();
  res.json(rows.map(r => ({ ...r, features: JSON.parse(r.features || '[]') })));
});

app.get('/api/sub-packages/all', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM sub_packages ORDER BY sort_order ASC, id ASC').all();
  res.json(rows.map(r => ({ ...r, features: JSON.parse(r.features || '[]') })));
});

app.post('/api/sub-packages', requireAuth, requireRole('super_admin'), async (req, res) => {
  const { name, price_pence, description = '', features = [], visible = 1, popular = 0, sort_order = 0 } = req.body;
  if (!name || !price_pence) return res.status(400).json({ error: 'Name and price required' });
  if (popular) db.prepare('UPDATE sub_packages SET popular=0').run();

  let stripePriceId = '';
  if (stripeConfigured) {
    try {
      const product = await stripe.products.create({ name: sanitize(name, 100) });
      const price   = await stripe.prices.create({ product: product.id, unit_amount: parseInt(price_pence), currency: 'gbp', recurring: { interval: 'month' } });
      stripePriceId = price.id;
    } catch (e) { console.error('Stripe product create failed:', e.message); }
  }

  const result = db.prepare(
    'INSERT INTO sub_packages (name,price_pence,stripe_price_id,description,features,visible,popular,sort_order) VALUES (?,?,?,?,?,?,?,?)'
  ).run(sanitize(name, 100), parseInt(price_pence), stripePriceId, sanitize(description, 500), JSON.stringify(Array.isArray(features) ? features : []), visible ? 1 : 0, popular ? 1 : 0, parseInt(sort_order));
  logSecurity('admin_action', req, `sub-package ${result.lastInsertRowid} created`);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.put('/api/sub-packages/:id', requireAuth, requireRole('super_admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const { name, price_pence, description = '', features = [], visible = 1, popular = 0, sort_order = 0 } = req.body;
  if (popular) db.prepare('UPDATE sub_packages SET popular=0 WHERE id != ?').run(id);
  db.prepare('UPDATE sub_packages SET name=?,price_pence=?,description=?,features=?,visible=?,popular=?,sort_order=? WHERE id=?').run(
    sanitize(name, 100), parseInt(price_pence), sanitize(description, 500), JSON.stringify(Array.isArray(features) ? features : []), visible ? 1 : 0, popular ? 1 : 0, parseInt(sort_order), id
  );
  logSecurity('admin_action', req, `sub-package ${id} updated`);
  res.json({ ok: true });
});

app.delete('/api/sub-packages/:id', requireAuth, requireRole('super_admin'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  db.prepare('DELETE FROM sub_packages WHERE id=?').run(id);
  logSecurity('admin_action', req, `sub-package ${id} deleted`);
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   API: STRIPE CHECKOUT
═══════════════════════════════════════════════════════════ */
app.post('/api/subscribe/session', paymentLimiter, async (req, res) => {
  if (!stripeConfigured) return res.status(400).json({ error: 'Stripe not configured. Please add your API keys.' });

  const package_id     = parseInt(req.body?.package_id);
  const customer_name  = sanitize(req.body?.customer_name, 100);
  const customer_email = sanitize(req.body?.customer_email, 254);

  if (!package_id || !customer_name || !customer_email) return res.status(400).json({ error: 'Missing required fields' });
  if (!isEmail(customer_email)) return res.status(400).json({ error: 'Invalid email address' });

  const pkg = db.prepare('SELECT * FROM sub_packages WHERE id=? AND visible=1').get(package_id);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });

  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  try {
    let priceId = pkg.stripe_price_id;
    if (!priceId) {
      const product = await stripe.products.create({ name: pkg.name });
      const price   = await stripe.prices.create({ product: product.id, unit_amount: pkg.price_pence, currency: 'gbp', recurring: { interval: 'month' } });
      priceId = price.id;
      db.prepare('UPDATE sub_packages SET stripe_price_id=? WHERE id=?').run(priceId, pkg.id);
    }
    const checkoutSession = await stripe.checkout.sessions.create({
      mode:                 'subscription',
      line_items:           [{ price: priceId, quantity: 1 }],
      customer_email,
      payment_method_types: ['card', 'bacs_debit'],
      success_url:          `${baseUrl}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${baseUrl}/#subscriptions`,
      metadata:             { package_id: String(pkg.id), customer_name, customer_email },
    });
    res.json({ url: checkoutSession.url, sessionId: checkoutSession.id });
  } catch (err) {
    console.error('Stripe session error:', err.message);
    res.status(500).json({ error: 'Payment session could not be created' });
  }
});

app.get('/subscribe/success', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ═══════════════════════════════════════════════════════════
   API: SUBSCRIBERS
═══════════════════════════════════════════════════════════ */
app.get('/api/subscribers', requireAuth, requireRole('super_admin'), (req, res) => {
  const { status, search } = req.query;
  let q = 'SELECT * FROM subscribers';
  const params = [], where = [];
  if (status && status !== 'all') { where.push('status=?'); params.push(sanitize(status, 20)); }
  if (search) {
    where.push('(name LIKE ? OR email LIKE ? OR package_name LIKE ?)');
    params.push(...Array(3).fill(`%${sanitize(search, 100)}%`));
  }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY created_at DESC';
  res.json(db.prepare(q).all(...params));
});

app.put('/api/subscribers/:id/cancel', requireAuth, requireRole('super_admin'), async (req, res) => {
  const id  = parseInt(req.params.id);
  const sub = id ? db.prepare('SELECT * FROM subscribers WHERE id=?').get(id) : null;
  if (!sub) return res.status(404).json({ error: 'Subscriber not found' });
  if (stripeConfigured && sub.stripe_sub_id) {
    try { await stripe.subscriptions.update(sub.stripe_sub_id, { cancel_at_period_end: true }); }
    catch (e) { console.error('Stripe cancel failed:', e.message); }
  }
  db.prepare("UPDATE subscribers SET status='Cancelled' WHERE id=?").run(id);
  logSecurity('admin_action', req, `subscriber ${id} cancelled`);
  res.json({ ok: true });
});

app.post('/api/subscribers/:id/refund', requireAuth, requireRole('super_admin'), async (req, res) => {
  const ph = req.body?.payment_history_id
    ? db.prepare('SELECT * FROM payment_history WHERE id=?').get(parseInt(req.body.payment_history_id))
    : null;
  if (!ph?.stripe_payment_id) return res.status(400).json({ error: 'No payment to refund' });
  if (!stripeConfigured) return res.status(400).json({ error: 'Stripe not configured' });
  try {
    await stripe.refunds.create({ payment_intent: ph.stripe_payment_id });
    db.prepare("UPDATE payment_history SET status='Refunded' WHERE id=?").run(ph.id);
    logSecurity('payment_event', req, `refund issued for payment_history ${ph.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Refund could not be processed' });
  }
});

/* ═══════════════════════════════════════════════════════════
   API: PAYMENT HISTORY
═══════════════════════════════════════════════════════════ */
app.get('/api/payment-history', requireAuth, requireRole('super_admin'), (req, res) => {
  const { status, search } = req.query;
  let q = 'SELECT * FROM payment_history';
  const params = [], where = [];
  if (status && status !== 'all') { where.push('status=?'); params.push(sanitize(status, 20)); }
  if (search) {
    where.push('(customer_name LIKE ? OR customer_email LIKE ? OR package_name LIKE ?)');
    params.push(...Array(3).fill(`%${sanitize(search, 100)}%`));
  }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY created_at DESC';
  res.json(db.prepare(q).all(...params));
});

/* ═══════════════════════════════════════════════════════════
   API: PAYMENT SETTINGS (super_admin only)
═══════════════════════════════════════════════════════════ */
const PAYMENT_SETTING_KEYS = ['bank_holder_name','bank_sort_code','bank_account_number','bank_name','bank_payout_schedule','bank_next_payout','payment_notify_email','payment_notify_from','payment_notify_new_sub','payment_notify_failed'];

app.get('/api/payment-settings', requireAuth, requireRole('super_admin'), (req, res) => {
  const rows = db.prepare(`SELECT key,value FROM settings WHERE key IN (${PAYMENT_SETTING_KEYS.map(() => '?').join(',')})`)
    .all(...PAYMENT_SETTING_KEYS);
  const data = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (data.bank_account_number?.length > 4)  data.bank_account_number = '****' + data.bank_account_number.slice(-4);
  if (data.bank_sort_code?.length > 4)        data.bank_sort_code      = '**-**-' + data.bank_sort_code.slice(-2);
  data.stripe_configured = stripeConfigured;
  res.json(data);
});

app.put('/api/payment-settings', requireAuth, requireRole('super_admin'), (req, res) => {
  const upd = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  db.transaction(() => {
    for (const k of PAYMENT_SETTING_KEYS) {
      if (req.body[k] !== undefined) {
        const val = sanitize(String(req.body[k]), 200);
        if ((k === 'bank_account_number' || k === 'bank_sort_code') && val.includes('*')) continue;
        upd.run(k, val);
      }
    }
  })();
  logSecurity('admin_action', req, 'payment settings updated');
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   API: PAYMENT DASHBOARD
═══════════════════════════════════════════════════════════ */
app.get('/api/payment-dashboard', requireAuth, requireRole('super_admin'), (req, res) => {
  const now        = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const activeCount    = db.prepare("SELECT COUNT(*) as c FROM subscribers WHERE status='Active'").get().c;
  const failedCount    = db.prepare("SELECT COUNT(*) as c FROM subscribers WHERE status='Failed'").get().c;
  const cancelledCount = db.prepare("SELECT COUNT(*) as c FROM subscribers WHERE status='Cancelled'").get().c;
  const mrr            = db.prepare("SELECT SUM(amount_pence) as total FROM payment_history WHERE status='Paid' AND created_at >= ?").get(monthStart);
  const recentPayments = db.prepare('SELECT * FROM payment_history ORDER BY created_at DESC LIMIT 5').all();
  res.json({ activeCount, failedCount, cancelledCount, mrr: mrr?.total || 0, recentPayments });
});

/* ═══════════════════════════════════════════════════════════
   API: GDPR / CONSENT
═══════════════════════════════════════════════════════════ */

/* Public: log cookie consent from the banner */
app.post('/api/consent', (req, res) => {
  const email       = sanitize(req.body?.email || '', 254);
  const preferences = req.body?.preferences;
  const source      = sanitize(req.body?.source || 'cookie_banner', 50);

  if (!preferences || typeof preferences !== 'object') return res.status(400).json({ error: 'preferences required' });

  const ins = db.prepare('INSERT INTO consent_log (customer_email,consent_type,given,source) VALUES (?,?,?,?)');
  db.transaction(() => {
    for (const [type, given] of Object.entries(preferences)) {
      ins.run(email, sanitize(String(type), 50), given ? 1 : 0, source);
    }
  })();
  res.json({ ok: true });
});

/* Admin: search customers across bookings + contacts */
app.get('/api/admin/privacy/customers', requireAuth, (req, res) => {
  const q = `%${sanitize(req.query.q || '', 100)}%`;
  const bookings  = db.prepare('SELECT id,name,email,phone,tier,frequency,status,created_at,marketing_consent,marketing_consent_at FROM bookings WHERE name LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT 50').all(q, q);
  const contacts  = db.prepare('SELECT id,name,email,phone,message,created_at,marketing_consent,marketing_consent_at FROM contacts WHERE name LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT 50').all(q, q);
  const subscribers = db.prepare('SELECT id,name,email,package_name,status,created_at FROM subscribers WHERE name LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT 50').all(q, q);
  res.json({ bookings, contacts, subscribers });
});

/* Admin: export all data for a customer (Right of Access / Portability) */
app.get('/api/admin/privacy/export', requireAuth, (req, res) => {
  const email = sanitize(req.query.email || '', 254);
  if (!email) return res.status(400).json({ error: 'email required' });

  const bookings    = db.prepare('SELECT * FROM bookings WHERE email=? ORDER BY created_at DESC').all(email).map(r => ({ ...r, addons: JSON.parse(r.addons || '[]') }));
  const contacts    = db.prepare('SELECT * FROM contacts WHERE email=? ORDER BY created_at DESC').all(email);
  const subscribers = db.prepare('SELECT id,name,email,package_name,status,start_date,next_payment_date,created_at FROM subscribers WHERE email=? ORDER BY created_at DESC').all(email);
  const consentLog  = db.prepare('SELECT * FROM consent_log WHERE customer_email=? ORDER BY created_at DESC').all(email);

  res.setHeader('Content-Disposition', `attachment; filename="customer-data-${Date.now()}.json"`);
  res.json({ exported_at: new Date().toISOString(), email, bookings, contacts, subscribers, consent_log: consentLog });
});

/* Admin: delete/anonymise customer data (Right to Erasure) */
app.post('/api/admin/privacy/delete', requireAuth, requireRole('super_admin'), (req, res) => {
  const email  = sanitize(req.body?.email || '', 254);
  const reason = sanitize(req.body?.reason || '', 500);
  if (!email) return res.status(400).json({ error: 'email required' });

  const now   = new Date().toISOString();
  const anon  = `[deleted-${Date.now()}]`;

  db.transaction(() => {
    /* Bookings: anonymise name/phone/make/model, keep tier & payment reference for legal records */
    db.prepare("UPDATE bookings SET name=?,email=?,phone='',vehicle_make='',vehicle_model='' WHERE email=?").run(anon, anon + '@deleted', email);
    /* Contacts: anonymise */
    db.prepare("UPDATE contacts SET name=?,email=?,phone='',message='[Data deleted by user request]' WHERE email=?").run(anon, anon + '@deleted', email);
    /* Subscribers: anonymise name/email (payment records kept 6 years per HMRC) */
    db.prepare("UPDATE subscribers SET name=?,email=? WHERE email=?").run(anon, anon + '@deleted', email);
    /* Log the erasure */
    db.prepare("INSERT INTO consent_log (customer_email,consent_type,given,source) VALUES (?,?,?,?)").run(email, 'erasure_request', 1, 'admin_panel');
  })();

  logSecurity('gdpr_erasure', req, `Data deleted for ${email}. Reason: ${reason}`);
  res.json({ ok: true, anonymised_at: now });
});

/* Admin: view consent log */
app.get('/api/admin/privacy/consent-log', requireAuth, (req, res) => {
  const { email, type } = req.query;
  let q = 'SELECT * FROM consent_log';
  const params = [], where = [];
  if (email) { where.push('customer_email LIKE ?'); params.push(`%${sanitize(email, 100)}%`); }
  if (type)  { where.push('consent_type=?'); params.push(sanitize(type, 50)); }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY created_at DESC LIMIT 200';
  res.json(db.prepare(q).all(...params));
});

/* Admin: view breach log */
app.get('/api/admin/privacy/breach-log', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM breach_log ORDER BY created_at DESC').all());
});

/* Admin: report a breach */
app.post('/api/admin/privacy/breach', requireAuth, requireRole('super_admin'), (req, res) => {
  const discovered_at       = sanitize(req.body?.discovered_at || new Date().toISOString(), 30);
  const nature              = sanitize(req.body?.nature || '', 1000);
  const data_categories     = sanitize(req.body?.data_categories || '', 500);
  const individuals_affected = parseInt(req.body?.individuals_affected) || 0;
  const actions_taken       = sanitize(req.body?.actions_taken || '', 2000);
  const ico_notified        = req.body?.ico_notified ? 1 : 0;
  const reporter            = sanitize(req.session?.adminUsername || '', 100);

  if (!nature) return res.status(400).json({ error: 'Nature of breach required' });

  const result = db.prepare(
    'INSERT INTO breach_log (discovered_at,nature,data_categories,individuals_affected,actions_taken,ico_notified,reporter) VALUES (?,?,?,?,?,?,?)'
  ).run(discovered_at, nature, data_categories, individuals_affected, actions_taken, ico_notified, reporter);

  logSecurity('data_breach_reported', req, `Breach logged: ${nature.slice(0,80)}`);
  res.json({ ok: true, id: result.lastInsertRowid });
});

/* ═══════════════════════════════════════════════════════════
   UNSUBSCRIBE (one-click, stateless HMAC token)
═══════════════════════════════════════════════════════════ */
app.get('/unsubscribe', (req, res) => {
  const email = sanitize(req.query.email || '', 254).toLowerCase().trim();
  const token = sanitize(req.query.token || '', 64);

  const html = (success, heading, body) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${heading} — Clean Torque Detailing</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:#0D0D0D;color:#F5F5F5;font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#0A1628;border:1px solid rgba(196,196,196,.1);border-radius:12px;max-width:480px;width:100%;padding:48px 40px;text-align:center}
    .icon{font-size:2.4rem;margin-bottom:20px}
    h1{font-family:'Bebas Neue',sans-serif;font-size:2rem;letter-spacing:.08em;margin-bottom:14px;color:${success ? '#1A6FFF' : '#C4C4C4'}}
    p{color:#C4C4C4;font-size:.95rem;line-height:1.7;margin-bottom:24px}
    a{display:inline-block;padding:12px 28px;background:#1A6FFF;color:#F5F5F5;border-radius:6px;font-weight:500;text-decoration:none;font-size:.9rem}
    a:hover{background:#0D3D99}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '✓' : '✗'}</div>
    <h1>${heading}</h1>
    <p>${body}</p>
    <a href="/">Back to site</a>
  </div>
</body>
</html>`;

  if (!email || !token) {
    return res.status(400).send(html(false, 'Invalid Link', 'This unsubscribe link is missing required information. Please contact us at <a href="mailto:privacy@cleantorquedetailing.co.uk" style="color:#1A6FFF">privacy@cleantorquedetailing.co.uk</a> to opt out manually.'));
  }

  let expected;
  try { expected = generateUnsubscribeToken(email); } catch { expected = ''; }

  const tokenBuf   = Buffer.from(token,    'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const valid = tokenBuf.length === expectedBuf.length &&
    tokenBuf.length > 0 &&
    crypto.timingSafeEqual(tokenBuf, expectedBuf);

  if (!valid) {
    return res.status(403).send(html(false, 'Invalid Link', 'This unsubscribe link is invalid or has already been used. Contact us at <a href="mailto:privacy@cleantorquedetailing.co.uk" style="color:#1A6FFF">privacy@cleantorquedetailing.co.uk</a> to opt out manually.'));
  }

  db.transaction(() => {
    db.prepare("UPDATE bookings SET marketing_consent=0,marketing_consent_at=? WHERE LOWER(email)=?")
      .run(new Date().toISOString(), email);
    db.prepare("UPDATE contacts SET marketing_consent=0,marketing_consent_at=? WHERE LOWER(email)=?")
      .run(new Date().toISOString(), email);
    db.prepare("INSERT INTO consent_log (customer_email,consent_type,given,source) VALUES (?,?,0,'unsubscribe_link')")
      .run(email, 'marketing_email');
  })();

  res.send(html(true, 'Unsubscribed', `The email address <strong>${email}</strong> has been removed from all Clean Torque Detailing marketing communications. You will still receive transactional emails (booking confirmations, receipts) as these are required to deliver your service.`));
});

/* ═══════════════════════════════════════════════════════════
   DATA RETENTION CLEANUP
   Enforces the retention periods stated in the Privacy Policy:
     - Bookings / contacts:  anonymise after 2 years
     - Security log:         delete after 90 days
     - Cookie consent log:   delete non-marketing entries after 13 months
═══════════════════════════════════════════════════════════ */
function retentionStats() {
  return {
    bookings_due:      db.prepare("SELECT COUNT(*) as c FROM bookings WHERE created_at < datetime('now','-2 years') AND name NOT LIKE '[deleted-%'").get().c,
    contacts_due:      db.prepare("SELECT COUNT(*) as c FROM contacts WHERE created_at < datetime('now','-2 years') AND name NOT LIKE '[deleted-%'").get().c,
    security_log_due:  db.prepare("SELECT COUNT(*) as c FROM security_log WHERE created_at < datetime('now','-90 days')").get().c,
    consent_log_due:   db.prepare("SELECT COUNT(*) as c FROM consent_log WHERE created_at < datetime('now','-395 days') AND consent_type NOT IN ('marketing_email','erasure_request')").get().c,
  };
}

function runRetentionCleanup() {
  const anon = `[deleted-${Date.now()}]`;
  const anonEmail = `${anon}@deleted`;
  const now = new Date().toISOString();

  const result = db.transaction(() => {
    const b = db.prepare("UPDATE bookings SET name=?,email=?,phone='',vehicle_make='',vehicle_model='' WHERE created_at < datetime('now','-2 years') AND name NOT LIKE '[deleted-%'")
      .run(anon, anonEmail);
    const c = db.prepare("UPDATE contacts SET name=?,email=?,phone='',message='[Deleted per retention policy]' WHERE created_at < datetime('now','-2 years') AND name NOT LIKE '[deleted-%'")
      .run(anon, anonEmail);
    const s = db.prepare("DELETE FROM security_log WHERE created_at < datetime('now','-90 days')").run();
    const cl = db.prepare("DELETE FROM consent_log WHERE created_at < datetime('now','-395 days') AND consent_type NOT IN ('marketing_email','erasure_request')").run();
    return { bookings: b.changes, contacts: c.changes, security_log: s.changes, consent_log: cl.changes };
  })();

  console.log(`✓ Retention cleanup ran at ${now}:`, result);
  return { ...result, ran_at: now };
}

app.get('/api/admin/privacy/retention-stats', requireAuth, (_req, res) => {
  res.json(retentionStats());
});

app.post('/api/admin/privacy/retention-cleanup', requireAuth, requireRole('super_admin'), (req, res) => {
  const result = runRetentionCleanup();
  logSecurity('retention_cleanup', req, JSON.stringify(result));
  res.json({ ok: true, ...result });
});

/* Admin: generate a one-click unsubscribe link for a given email */
app.get('/api/admin/privacy/unsubscribe-link', requireAuth, (req, res) => {
  const email = sanitize(req.query.email || '', 254).toLowerCase().trim();
  if (!email || !isEmail(email)) return res.status(400).json({ error: 'Valid email required' });
  const token = generateUnsubscribeToken(email);
  const base  = process.env.APP_BASE_URL || 'http://localhost:3000';
  res.json({ url: `${base}/unsubscribe?email=${encodeURIComponent(email)}&token=${token}` });
});

/* ── Frontend catch-all ──────────────────────────────────── */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/privacy-policy', (req, res) => res.sendFile(path.join(__dirname, 'privacy-policy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));

/* ── Centralised error handler (never leaks stack traces) ─── */
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError || err?.message === 'File type not allowed') {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'An unexpected error occurred' });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`✓ Clean Torque server → http://localhost:${PORT}`);
  // Run retention cleanup on startup then every 24 h
  runRetentionCleanup();
  setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000);
});
