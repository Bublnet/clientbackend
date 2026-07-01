import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import dotenv from 'dotenv';
import { analyticsMiddleware } from './analysis/analytics_logger.js';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { getApps } from 'firebase-admin/app';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

// Local firebase init (points to main backend service account by default for harmony)
import { db, auth, hasFirebaseServerCredentials, initFirebaseAdmin } from './firebase.config.js';
import supabase, { isSupabaseConfigured } from './supabase.client.js';
import sharp from 'sharp';
import { processAndUploadToCdn, MOCK_CDN, STORAGE_100_BUCKET, LOGO_BUCKET, resizeTo100 } from './image-processor.js';
import { ensureSupabaseSchema } from './supabase-migrate.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4002;

const APP_MODE = process.env.APP_MODE || (process.env.NODE_ENV === 'production' ? 'production' : 'test');

const PROD_FRONTEND_URL = 'https://dvenue.space';
const TEST_FRONTEND_URL = 'http://localhost:8080';
const FRONTEND_URL = APP_MODE === 'production' ? PROD_FRONTEND_URL : TEST_FRONTEND_URL;

const PROD_PAYMENTS_URL = 'https://payments-brown-one.vercel.app';
const TEST_PAYMENTS_URL = 'http://localhost:4001';
const PAYMENTS_URL = process.env.PAYMENTS_SERVICE_URL || (APP_MODE === 'production' ? PROD_PAYMENTS_URL : TEST_PAYMENTS_URL);

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const AUTH_REDIRECT_URL = process.env.AUTH_REDIRECT_URL || FRONTEND_URL;
const DEFAULT_ADMIN_EMAIL = process.env.DEFAULT_ADMIN_EMAIL;
const ADMIN_LOGIN_IDENTIFIER = process.env.ADMIN_LOGIN_IDENTIFIER;
const ADMIN_TOKEN_PATTERN = /^asdf_[A-Za-z0-9_-]{43}$/;

const AUTH_OTP_TTL_MS = Number(process.env.AUTH_OTP_TTL_MS || 10 * 60 * 1000);
const authBaseUrl = `https://identitytoolkit.googleapis.com/v1/accounts`;

const ENABLE_OTP_VERIFY = (process.env.ENABLE_OTP_VERIFY || 'false').toLowerCase() === 'true';
const ENABLE_GOOGLE_SIGNIN = (process.env.ENABLE_GOOGLE_SIGNIN || 'false').toLowerCase() === 'true';

initFirebaseAdmin();

if (isSupabaseConfigured()) {
  console.log('[clientbackend] Supabase CDN configured for image uploads.');
  console.log(`[clientbackend] Storage bucket: ${process.env.SUPABASE_STORAGE_BUCKET || 'bublnetorg'}.`);
  console.log('[clientbackend] The server will now give a clear error + instructions on first upload if the bucket is missing.');
} else {
  console.warn('[clientbackend] Supabase CDN NOT configured. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for /api/cdn/upload to work.');
}

// Global error handlers to catch startup/runtime issues and log with [clientbackend] prefix
process.on('uncaughtException', (err) => {
  console.error('[clientbackend] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[clientbackend] Unhandled Rejection at:', promise, 'reason:', reason);
});

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.set('trust proxy', 1);

app.use('/public', express.static(path.join(__dirname, 'public')));

async function updateStaticPincodeCache() {
  try {
    const { data: approved, error } = await supabase
      .from('venues')
      .select('*')
      .eq('status', 'approved');

    if (error) throw error;

    const byPincode = {};
    for (const v of approved) {
      if (!v.pincode) continue;
      const prefix = String(v.pincode).substring(0, 3);
      if (!byPincode[prefix]) byPincode[prefix] = [];
      byPincode[prefix].push(toListing(v));
    }

    const publicDir = path.join(__dirname, 'public', 'pincodes');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }

    const desiredFiles = new Set(
      Object.keys(byPincode).map((prefix) => `${prefix}.json`),
    );
    let changedFiles = 0;

    // Remove only cache entries that no longer have approved listings.
    const files = fs.readdirSync(publicDir);
    for (const file of files) {
      if (file.endsWith('.json') && !desiredFiles.has(file)) {
        fs.unlinkSync(path.join(publicDir, file));
        changedFiles += 1;
      }
    }

    for (const [prefix, list] of Object.entries(byPincode)) {
      const target = path.join(publicDir, `${prefix}.json`);
      const content = JSON.stringify({ ok: true, venues: list });
      const current = fs.existsSync(target)
        ? fs.readFileSync(target, 'utf8')
        : null;
      if (current === content) continue;

      // Replace atomically so readers never observe a partially written file.
      const temporary = `${target}.tmp`;
      fs.writeFileSync(temporary, content);
      fs.renameSync(temporary, target);
      changedFiles += 1;
    }
    console.log(
      changedFiles > 0
        ? `[clientbackend] Updated static pincode cache for ${Object.keys(byPincode).length} prefixes (${changedFiles} files changed).`
        : `[clientbackend] Static pincode cache is current for ${Object.keys(byPincode).length} prefixes.`,
    );
  } catch (err) {
    console.error('[clientbackend] Failed to update static pincode cache:', err);
  }
}

// CORS must be early so preflight OPTIONS for cross-origin POSTs (e.g. /api/cdn/upload from Flutter web on :8080)
// get proper Access-Control-Allow-Origin, methods, and headers (including Authorization).
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    // Robust localhost support for Flutter web dev (8080, 5000, any port)
    if (/^https?:\/\/(localhost|127\.0\.0\.1|::1)(:\d+)?$/.test(origin) || origin.includes('localhost')) {
      return callback(null, true);
    }

    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
  optionsSuccessStatus: 200,
}));
app.options('*', cors()); // explicit preflight handler

app.use(helmet({ crossOriginResourcePolicy: false }));
// Raised limit to support base64 image data for single-image CDN uploads (picker compresses to ~1280px@72%).
// Each /cdn/upload is one image at a time. Final /venues payload is small (only URLs).
app.use(express.json({ limit: '15mb' }));

// Track client backend traffic
app.use(analyticsMiddleware('clientbackend'));

// Global Data Logging Middleware
const schemaReady = ensureSupabaseSchema();
const dataReady = schemaReady.then(async (result) => {
  if (isSupabaseConfigured()) {
    try {
      await backfillListingOwnerEmails();
    } catch (error) {
      console.warn('[clientbackend] Owner-email backfill skipped:', error.message);
    }
  }
  await updateStaticPincodeCache();
  return result;
});
app.use(async (_req, res, next) => {
  try {
    await dataReady;
    next();
  } catch (error) {
    console.error('[clientbackend] Supabase schema is unavailable:', error.message);
    res.status(503).json({
      ok: false,
      message: 'Supabase database initialization failed. Check SUPABASE_DB_URL and server logs.',
    });
  }
});

// Rate limiters (client surface - slightly stricter defaults)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT || 60),
  message: { ok: false, message: 'Too many auth attempts. Please try again later.' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.WRITE_RATE_LIMIT || 60),
  message: { ok: false, message: 'Too many write requests. Slow down.' },
});

// --- Shared helpers (keep in sync with main backend/ for harmony) ---
function nowIso() { return new Date().toISOString(); }

function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function requireString(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    const error = new Error(`${field} is required.`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function firebasePasswordRequest(action, payload) {
  if (action === 'signInWithPassword') {
    const { data, error } = await supabase.auth.signInWithPassword({ email: payload.email, password: payload.password });
    if (error) throw { status: 400, message: error.message };
    return { idToken: data.session.access_token, localId: data.user.id, email: data.user.email };
  }
  if (action === 'signUp') {
    const { data, error } = await supabase.auth.signUp({ 
      email: payload.email, 
      password: payload.password,
      options: { emailRedirectTo: AUTH_REDIRECT_URL }
    });
    if (error) throw { status: 400, message: error.message };
    return { idToken: data.session?.access_token || '', localId: data.user.id, email: data.user.email };
  }
  if (action === 'sendOobCode') {
    const { error } = await supabase.auth.resetPasswordForEmail(payload.email, {
      redirectTo: AUTH_REDIRECT_URL
    });
    if (error) throw { status: 400, message: error.message };
    return {};
  }
  throw new Error(`Unsupported auth action: ${action}`);
}

function mapFirebaseAuthError(code) {
  return code;
}

async function handleError(res, error) {
  console.error('[clientbackend] ERROR:', error);
  const msg = error.message || 'Internal server error.';
  return res.status(error.status || 500).json({
    ok: false,
    message: msg,
    // Include stack for debugging (remove in prod if needed)
    details: error.toString ? error.toString() : String(error),
  });
}

async function getUserProfile(uid) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();
  if (error) throw error;
  if (!data) return { id: uid };
  return {
    ...data,
    id: uid,
    name: data.display_name,
    identifier: data.email,
    parentId: data.parent_id,
  };
}

async function ensureUserProfile(uid, fallback = {}) {
  const existing = await getUserProfile(uid);
  const profile = {
    ...existing,
    ...fallback,
    updatedAt: nowIso(),
  };
  if (!existing.createdAt) profile.createdAt = nowIso();
  if (DEFAULT_ADMIN_EMAIL && (profile.identifier === DEFAULT_ADMIN_EMAIL || profile.email === DEFAULT_ADMIN_EMAIL)) {
    profile.role = 'admin';
  } else if (!profile.role) {
    profile.role = 'client';
  }
  const ref = db.collection('users').doc(uid);
  await ref.set(profile, { merge: true });
  return { id: uid, ...existing, ...profile };
}

function publicUser(profile) {
  return {
    id: profile.id,
    name: profile.name || 'Dvenue User',
    identifier: profile.identifier || profile.email || '',
    email: profile.email || profile.identifier || '',
    role: profile.role || 'client',
    parentId: profile.parentId || profile.parent_id || null,
    permissions: profile.permissions || {},
    isPremium: profile.isPremium === true || profile.is_premium === true,
    adAccessUntil: profile.adAccessUntil || profile.ad_access_until || null,
  };
}

async function backfillListingOwnerEmails() {
  const { data: listings, error } = await supabase
    .from('venues')
    .select('id,ownerId,ownerEmail')
    .is('ownerEmail', null)
    .limit(500);
  if (error) throw error;

  const emailByOwner = new Map();
  for (const listing of listings || []) {
    if (!listing.ownerId) continue;
    if (!emailByOwner.has(listing.ownerId)) {
      const profile = await getUserProfile(listing.ownerId);
      emailByOwner.set(
        listing.ownerId,
        normalizeIdentifier(profile.email || profile.identifier),
      );
    }
    const ownerEmail = emailByOwner.get(listing.ownerId);
    if (!ownerEmail) continue;
    const { error: updateError } = await supabase
      .from('venues')
      .update({ ownerEmail })
      .eq('id', listing.id)
      .eq('ownerId', listing.ownerId);
    if (updateError) throw updateError;
  }
}

async function authenticateEnvAdminToken(token, req) {
  if (!ADMIN_TOKEN_PATTERN.test(String(token || ''))) return false;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const ref = db.collection('adminSessions').doc(tokenHash);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const session = snap.data();
  if (session.subject !== 'env-admin' || session.role !== 'admin' || Number(session.expiresAt) <= Date.now()) {
    await ref.delete().catch(() => {});
    return false;
  }
  const email = normalizeIdentifier(ADMIN_LOGIN_IDENTIFIER);
  const profile = {
    id: 'env-admin',
    name: process.env.ADMIN_DISPLAY_NAME || 'Dvenue Administrator',
    identifier: email,
    email,
    role: 'admin',
    isPremium: true,
  };
  req.auth = {
    source: 'env-admin',
    token,
    decoded: { uid: 'env-admin' },
    user: publicUser(profile),
    profile,
    sessionTokenHash: tokenHash,
  };
  return true;
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      const error = new Error('Missing or invalid Authorization header.');
      error.status = 401;
      throw error;
    }
    const idToken = match[1];

    if (await authenticateEnvAdminToken(idToken, req)) {
      return next();
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(idToken);
    if (authError || !authData?.user) {
      const authFailure = new Error('Session expired. Please login again.');
      authFailure.status = 401;
      throw authFailure;
    }
    const authUser = authData.user;
    const profile = await getUserProfile(authUser.id);
    
    const storedRole = profile.role;
    const metaRole = authUser.user_metadata?.role;
    profile.role = (storedRole && storedRole !== 'client') ? storedRole : (metaRole || storedRole || 'client');

    if (profile.active === false) {
      const disabled = new Error('This account has been disabled.');
      disabled.status = 403;
      throw disabled;
    }
    const decoded = { uid: authUser.id, sub: authUser.id, email: authUser.email };

    req.auth = {
      token: idToken,
      decoded,
      user: publicUser(profile),
      profile,
    };
    next();
  } catch (error) {
    error.status = error.status || 401;
    return handleError(res, error);
  }
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.user.role)) {
      return res.status(403).json({ ok: false, message: 'You do not have access to this action.' });
    }
    return next();
  };
}

const requireStaff = requireRole(['admin', 'staff']);
const requireHost = requireRole(['host']);

function ownerScopeId(authContext) {
  return authContext?.user?.role === 'hoststaff'
    ? authContext.user.parentId
    : authContext?.user?.id;
}

// Premium or ad soft-access gate (client reads)
function requirePremiumOrAd(req, res, next) {
  const profile = req.auth.profile || {};
  const isPremium = profile.isPremium === true || profile.is_premium === true;
  const adRaw = profile.adAccessUntil || profile.ad_access_until;
  let adAccessUntil = null;
  if (adRaw) {
    const d = typeof adRaw === 'string' ? new Date(adRaw) : (adRaw && adRaw.toDate ? adRaw.toDate() : new Date(adRaw));
    if (d instanceof Date && !Number.isNaN(d.getTime())) adAccessUntil = d;
  }
  const role = req.auth.user.role;
  const hasAccess = isPremium || ['admin', 'staff', 'host', 'hoststaff'].includes(role) || (adAccessUntil && adAccessUntil.getTime() > Date.now());

  if (!hasAccess) {
    return res.status(402).json({
      ok: false,
      message: 'Premium subscription or ad watch required for this action.',
      code: 'ACCESS_REQUIRED',
    });
  }
  next();
}

function hasVenueDetailsAccess(req) {
  const profile = req.auth?.profile || {};
  const isPremium = profile.isPremium === true || profile.is_premium === true;
  const adRaw = profile.adAccessUntil || profile.ad_access_until;
  const adUntil = adRaw
    ? (typeof adRaw === 'string' ? new Date(adRaw) : (adRaw?.toDate ? adRaw.toDate() : new Date(adRaw)))
    : null;
  return isPremium
    || ['admin', 'staff', 'host', 'hoststaff'].includes(req.auth?.user?.role)
    || (adUntil instanceof Date && !Number.isNaN(adUntil.getTime()) && adUntil.getTime() > Date.now());
}

function venueForViewer(listing, req) {
  if (hasVenueDetailsAccess(req)) return { ...listing, detailsLocked: false };
  return {
    ...listing,
    detailsLocked: true,
    basePrice: null,
    gstAmount: null,
    priceWithGst: null,
    priceRange: '',
    spaces: Array.isArray(listing.spaces)
      ? listing.spaces.map((space) => {
        const {
          dayPrice: _dayPrice,
          nightPrice: _nightPrice,
          hourlyPrices: _hourlyPrices,
          price: _price,
          ...safeSpace
        } = space || {};
        return safeSpace;
      })
      : [],
  };
}

function assertFirebaseServerConfigured() {
  if (hasFirebaseServerCredentials) return;
  const error = new Error('Firebase server credentials required for this operation.');
  error.status = 503;
  throw error;
}

function toListing(data) {
  // If it's a Firestore snapshot
  if (data && typeof data.data === 'function') {
      const snap = data;
      data = { id: snap.id, ...snap.data() };
  }
  // Otherwise assume it's already an object (from Supabase)

  return {
    ...data,
    id: data.id,
    basePrice: Number(data.basePrice || 0),
    priceWithGst: Number(data.priceWithGst || data.basePrice || 0),
    gstRate: Number(data.gstRate ?? 18),
    // Explicit for verified data fidelity (thumbnails from client Supabase CDN upload)
    thumbnails: Array.isArray(data.thumbnails) ? data.thumbnails : [],
  };
}

function toBooking(snap) {
  const data = snap.data() || {};
  return { id: snap.id, ...data };
}

// Helper to deeply remove undefined values (Firestore doesn't like them and can cause INVALID_ARGUMENT)
function cleanForFirestore(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(cleanForFirestore)
      .filter((v) => v !== undefined);
  }
  const result = {};
  for (const [key, val] of Object.entries(value)) {
    let cleaned = cleanForFirestore(val);
    if (cleaned !== undefined) {
      // Extra guard for any specTable (top or per-space) to prevent invalid nested
      if (key === 'specTable' && cleaned && typeof cleaned === 'object') {
        cleaned = sanitizeSpecTable(cleaned);
      }
      result[key] = cleaned;
    }
  }
  return result;
}

function sanitizeSpecTable(raw) {
  if (!raw || typeof raw !== 'object') {
    return { columns: ["Specification", "Details"], rows: [["Area", ""], ["Parking", ""]] };
  }
  return {
    columns: Array.isArray(raw.columns)
      ? raw.columns.map(c => (typeof c === 'string' ? c : String(c || ''))).filter(Boolean)
      : ["Specification", "Details"],
    rows: Array.isArray(raw.rows)
      ? raw.rows.map(row =>
          Array.isArray(row)
            ? row.map(cell => (typeof cell === 'string' ? cell : String(cell || '')))
            : []
        )
      : [["Area", ""], ["Parking", ""]]
  };
}

// --- Client-safe routes only (no admin/staff privileged set operations) ---
app.use([
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/signup/start',
  '/api/auth/signup/complete',
  '/api/auth/password-reset/start',
  '/api/auth/password-reset/verify',
  '/api/auth/password-reset/complete',
], (_req, res) => res.status(410).json({
  ok: false,
  message: 'Authenticate directly with Supabase Auth from the Flutter application.',
}));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'dvenue-clientbackend', port: PORT });
});

app.get('/api/config/public', (req, res) => {
  res.json({
    ok: true,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
    enableOtpVerify: ENABLE_OTP_VERIFY,
    enableGoogleSignin: ENABLE_GOOGLE_SIGNIN,
    clientOnly: true,
  });
});

// Auth (shared, but client tokens only get client profile powers)
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const identifier = normalizeIdentifier(req.body.identifier);
    const password = requireString(req.body.password, 'Password');
    if (!isEmail(identifier)) {
      return res.status(400).json({ ok: false, message: 'Email login is required.' });
    }
    const login = await firebasePasswordRequest('signInWithPassword', {
      email: identifier, password, returnSecureToken: true,
    });
    const profile = await ensureUserProfile(login.localId, { email: login.email, identifier: login.email });
    res.json({ ok: true, message: 'Welcome to Dvenue.', data: { token: login.idToken, user: publicUser(profile) } });
  } catch (error) {
    return handleError(res, error);
  }
});

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  if (ENABLE_OTP_VERIFY) {
    return res.status(400).json({ ok: false, message: 'OTP verification is enabled. Use signup start/complete.' });
  }
  try {
    assertFirebaseServerConfigured();
    const identifier = normalizeIdentifier(req.body.identifier);
    if (!isEmail(identifier)) return res.status(400).json({ ok: false, message: 'Email signup is required.' });
    const password = requireString(req.body.password, 'Password');

    const signup = await firebasePasswordRequest('signUp', { email: identifier, password, returnSecureToken: true });
    const profile = await ensureUserProfile(signup.localId, { email: signup.email, identifier: signup.email });

    res.json({ ok: true, message: 'Account created.', data: { token: signup.idToken, user: publicUser(profile) } });
  } catch (error) {
    return handleError(res, error);
  }
});

// (signup/start and /complete kept for when ENABLE_OTP_VERIFY=true - same as main)
app.post('/api/auth/signup/start', authLimiter, async (req, res) => {
  if (!ENABLE_OTP_VERIFY) {
    return res.status(400).json({ ok: false, message: 'OTP disabled. Use direct signup.' });
  }
  try {
    assertFirebaseServerConfigured();
    const identifier = normalizeIdentifier(req.body.identifier);
    if (!isEmail(identifier)) return res.status(400).json({ ok: false, message: 'Email required.' });

    const otp = process.env.AUTH_DEV_OTP || String(crypto.randomInt(100000, 999999));
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    await db.collection('authOtps').doc(identifier).set({
      identifier, otpHash, purpose: 'signup', expiresAt: Date.now() + AUTH_OTP_TTL_MS, attempts: 0, createdAt: nowIso(),
    });
    res.json({ ok: true, message: 'Verification code generated.', data: process.env.AUTH_RETURN_OTP === 'true' ? { otp } : {} });
  } catch (error) {
    return handleError(res, error);
  }
});

app.post('/api/auth/signup/complete', authLimiter, async (req, res) => {
  try {
    assertFirebaseServerConfigured();
    const identifier = normalizeIdentifier(req.body.identifier);
    const otp = requireString(req.body.otp, 'OTP');
    const password = requireString(req.body.password, 'Password');
    const ref = db.collection('authOtps').doc(identifier);
    const snap = await ref.get();
    const record = snap.data();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    if (!snap.exists || record.purpose !== 'signup' || record.expiresAt < Date.now() || record.otpHash !== otpHash) {
      return res.status(400).json({ ok: false, message: 'Invalid or expired OTP.' });
    }

    const signup = await firebasePasswordRequest('signUp', { email: identifier, password, returnSecureToken: true });
    await ref.delete();
    const profile = await ensureUserProfile(signup.localId, { email: signup.email, identifier: signup.email });

    res.json({ ok: true, message: 'Account created.', data: { token: signup.idToken, user: publicUser(profile) } });
  } catch (error) {
    return handleError(res, error);
  }
});

// Password reset (Firebase email link only - no in-app OTP for reset)
app.post('/api/auth/password-reset/start', authLimiter, async (req, res) => {
  try {
    const identifier = normalizeIdentifier(req.body.identifier);
    await firebasePasswordRequest('sendOobCode', { requestType: 'PASSWORD_RESET', email: identifier });
    res.json({ ok: true, message: 'Password reset email sent.' });
  } catch (error) {
    return handleError(res, error);
  }
});

// Validate / serve existing client session token (if not expired)
app.post('/api/auth/validate', authLimiter, async (req, res) => {
  try {
    const token = (req.body && req.body.token) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) {
      return res.status(400).json({ ok: false, message: 'Token required.' });
    }
    if (ADMIN_TOKEN_PATTERN.test(token)) {
      const mockReq = { headers: req.headers };
      if (!await authenticateEnvAdminToken(token, mockReq)) {
        return res.status(401).json({ ok: false, message: 'Admin session expired or invalid.' });
      }
      return res.json({
        ok: true,
        message: 'Session valid.',
        data: { token, user: mockReq.auth.user, expiresAt: null },
      });
    }
    // This will throw if expired/revoked/invalid
    const decoded = await auth.verifyIdToken(token, true);
    const profile = await getUserProfile(decoded.uid);
    // Client tokens only get client-level profile (admin/staff should use main backend for privileged actions)
    if (['admin', 'staff', 'manager'].includes(profile.role || '')) {
      // Still allow read of own profile, but warn that privileged ops belong on admin backend
      console.log('[clientbackend] Elevated role using client token for validate - ok for profile, privileged writes should use main backend.');
    }
    res.json({
      ok: true,
      message: 'Session valid.',
      data: { token, user: publicUser(profile), expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null },
    });
  } catch (error) {
    return res.status(401).json({ ok: false, message: 'Session token expired or invalid. Please sign in again.' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const profile = req.auth.profile || {};
  const isPremium = profile.isPremium === true || profile.is_premium === true;
  const adRaw = profile.adAccessUntil || profile.ad_access_until;
  let adAccessUntil = null;
  if (adRaw) {
    const d = typeof adRaw === 'string' ? new Date(adRaw) : (adRaw && adRaw.toDate ? adRaw.toDate() : new Date(adRaw));
    if (d instanceof Date && !Number.isNaN(d.getTime())) adAccessUntil = d.toISOString();
  }
  res.json({
    ok: true,
    data: {
      token: req.auth.token,
      user: req.auth.user,
      access: { isPremium: !!isPremium, adAccessUntil, hasAccess: true /* client backend already gated upstream */ },
    },
  });
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  if (req.auth.source === 'env-admin' && req.auth.sessionTokenHash) {
    await db.collection('adminSessions').doc(req.auth.sessionTokenHash).delete();
  }
  res.json({ ok: true, message: 'Logged out.' });
});

// --- Client data routes (read + limited own writes). 
// Client submits listings (full details + Supabase CDN image URLs) here for verification.
// Admin "set" operations (approve/reject on pending, which makes verified data available
// for public queries + bookings on BOTH surfaces) live only on main backend/. ---

// Explore / search (gated by premium/ad for full access)
app.get('/api/venues/explore', requireAuth, async (req, res) => {
  try {
    const { data: venues, error } = await supabase
      .from('venues')
      .select('*')
      .eq('status', 'approved');
      
    if (error) throw error;
    const formattedVenues = venues.map(toListing).map((listing) => venueForViewer(listing, req));
    res.json({ ok: true, message: 'Venues loaded.', venues: formattedVenues, nearby: formattedVenues, all: formattedVenues });
  } catch (error) {
    return handleError(res, error);
  }
});

app.get('/api/venues/search', requireAuth, async (req, res) => {
  try {
    const { data: results, error } = await supabase
      .from('venues')
      .select('*')
      .eq('status', 'approved');
      
    if (error) throw error;
    res.json({
      ok: true,
      message: 'Search complete.',
      results: results.map(toListing).map((listing) => venueForViewer(listing, req)),
    });
  } catch (error) {
    return handleError(res, error);
  }
});

app.get('/api/venues/:id([0-9a-fA-F-]{36})', requireAuth, async (req, res) => {
  try {
    const { data: listing, error } = await supabase
      .from('venues')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) {
       if (error.code === 'PGRST116') return res.status(404).json({ ok: false, message: 'Listing not found.' });
       throw error;
    }
    
    const formattedListing = toListing(listing);
    if (formattedListing.status !== 'approved') return res.status(404).json({ ok: false, message: 'Listing not found.' });
    return res.json({ ok: true, listing: venueForViewer(formattedListing, req) });
  } catch (error) {
    return handleError(res, error);
  }
});

// Owner's own listings (client can see their submissions)
app.get('/api/venues/mine', requireAuth, async (req, res) => {
  try {
    // Allow all roles including clients to see their own submitted listings
    const ownerId = ownerScopeId(req.auth);
    const ownerEmail = normalizeIdentifier(req.auth.profile.email || req.auth.user.identifier);
    const { data: listings, error } = await supabase
      .from('venues')
      .select('*')
      .eq('ownerId', ownerId);
      
    if (error) throw error;
    if (req.auth.user.role === 'host' && ownerEmail && listings.some((listing) => !listing.ownerEmail)) {
      await supabase
        .from('venues')
        .update({ ownerEmail, updatedAt: nowIso() })
        .eq('ownerId', ownerId)
        .is('ownerEmail', null);
    }
    res.json({
      ok: true,
      message: 'Listings loaded.',
      listings: listings.map((listing) => toListing({
        ...listing,
        ownerEmail: listing.ownerEmail || ownerEmail,
      })),
    });
  } catch (error) {
    return handleError(res, error);
  }
});

// Admin pending (fetched by main admin backend for verification flow)
app.get('/api/venues/admin/pending', requireAuth, requireStaff, async (req, res) => {
  try {
    const { data: listings, error } = await supabase
      .from('venues')
      .select('*')
      .eq('status', 'pending');
      
    if (error) throw error;
    res.json({ ok: true, message: 'Pending listings loaded.', listings: listings.map(toListing) });
  } catch (error) {
    return handleError(res, error);
  }
});

app.get('/api/venues/admin/all', requireAuth, requireStaff, async (req, res) => {
  try {
    const { data: listings, error } = await supabase
      .from('venues')
      .select('*')
      .order('updatedAt', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, message: 'All listings loaded.', listings: listings.map(toListing) });
  } catch (error) {
    return handleError(res, error);
  }
});

app.patch('/api/venues/admin/:id/verification', requireAuth, requireStaff, async (req, res) => {
  try {
    const status = String(req.body.status || '');
    if (!['contacted', 'details_verified'].includes(status)) {
      return res.status(400).json({ ok: false, message: 'Invalid verification status.' });
    }
    const update = {
      verificationStatus: status,
      verificationNotes: req.body.notes || null,
      updatedAt: nowIso(),
      ...(status === 'contacted' ? { contactedAt: nowIso() } : {}),
    };
    const { data: listing, error } = await supabase
      .from('venues')
      .update(update)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, message: 'Verification stage updated.', listing: toListing(listing) });
  } catch (error) {
    return handleError(res, error);
  }
});

app.patch('/api/venues/admin/:id/review', requireAuth, requireStaff, async (req, res) => {
  try {
    const approve = req.body.approve === true;
    const update = approve
      ? {
          status: 'approved',
          verified: true,
          verificationStatus: 'approved',
          approvedAt: nowIso(),
          rejectionReason: null,
          updatedAt: nowIso(),
        }
      : {
          status: 'rejected',
          verified: false,
          verificationStatus: 'rejected',
          rejectionReason: req.body.reason || 'Rejected',
          updatedAt: nowIso(),
        };
    const { data: listing, error } = await supabase
      .from('venues')
      .update(update)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;

    if (approve) {
      await updateStaticPincodeCache();
    }

    res.json({
      ok: true,
      message: approve ? 'Listing approved.' : 'Listing rejected.',
      listing: toListing(listing),
    });
  } catch (error) {
    return handleError(res, error);
  }
});

// Client submit / update own listing (full payload with (mock or real) CDN URLs for images+thumbnails).
// This is the path that sends client data to the *client server* for (later admin) verification.
// Admin verifies on main backend (4000), which updates the shared data (status to approved etc.).
// This separation secures client-submitted pending data.
app.post('/api/venues', requireAuth, writeLimiter, async (req, res) => {
  try {
    // Accept ALL details from client (including submittedAt, images as CDN URLs only, specTable, price, location, etc.)
    // Never accept base64 blobs here — client must upload images to Supabase CDN (via /api/cdn/upload) first and only send final links.
    const clientPayload = req.body || {};
    // Accept the full rich payload sent by the Flutter client form after Supabase CDN upload
    // (images + thumbnails as public Supabase CDN URLs, specTable, pricing, location, submittedAt, etc.).
    // This is the "data sent to the client server for (admin) verification".
    // Client writes ONLY here (pending). Admin backend fetches from here for verification,
    // then "pushes" verified (status update) so it appears in main backend approved reads.
    // This separation means clients cannot write/modify approved data; only admin can.
    const safeSpecTable = sanitizeSpecTable(clientPayload.specTable);

    const payload = cleanForFirestore({
      ...clientPayload,
      ownerId: req.auth.user.id,
      ownerEmail: normalizeIdentifier(req.auth.profile.email || req.auth.user.identifier),
      ownerName: req.auth.user.name,
      status: 'pending',
      submittedAt: clientPayload.submittedAt || nowIso(),
      updatedAt: nowIso(),
      // sanitize/override critical fields (never allow raw blobs here)
      images: Array.isArray(clientPayload.images)
        ? clientPayload.images.filter((i) => typeof i === 'string' && i.startsWith('http'))
        : [],
      thumbnails: Array.isArray(clientPayload.thumbnails)
        ? clientPayload.thumbnails.filter((t) => typeof t === 'string' && t.startsWith('http'))
        : [],
      coverImage: (typeof clientPayload.coverImage === 'string' && clientPayload.coverImage.startsWith('http'))
        ? clientPayload.coverImage
        : '',
      specTable: safeSpecTable,
      // Sanitize per-space specTable (flexible specs like pricing)
      spaces: Array.isArray(clientPayload.spaces)
        ? clientPayload.spaces.map(sp => {
            const s = { ...sp };
            s.specTable = sanitizeSpecTable(s.specTable);
            return s;
          })
        : clientPayload.spaces,
    });

    const { data: inserted, error: insertError } = await supabase
      .from('venues')
      .insert(payload)
      .select()
      .single();

    if (insertError) throw insertError;
    
    res.status(201).json({ ok: true, message: 'Listing submitted for admin review.', listing: toListing(inserted) });
  } catch (error) {
    return handleError(res, error);
  }
});

app.put('/api/venues/:id', requireAuth, writeLimiter, async (req, res) => {
  try {
    const { data: existing, error: readError } = await supabase
      .from('venues')
      .select('id,ownerId,ownerEmail,status,verified,"verificationStatus"')
      .eq('id', req.params.id)
      .single();
    if (readError || !existing) {
      return res.status(404).json({ ok: false, message: 'Listing not found.' });
    }
    if (existing.ownerId !== ownerScopeId(req.auth)) {
      return res.status(403).json({ ok: false, message: 'You do not own this listing.' });
    }

    const clientPayload = req.body || {};
    const isCalendarOnly = clientPayload.calendarOnly === true;
    if (req.auth.user.role === 'hoststaff' && !isCalendarOnly) {
      return res.status(403).json({
        ok: false,
        message: 'Host staff may update prices and availability only.',
      });
    }
    const update = cleanForFirestore({
      ...clientPayload,
      id: undefined,
      ownerId: undefined,
      ownerEmail: undefined,
      ownerName: undefined,
      status: isCalendarOnly ? existing.status : 'pending',
      verified: isCalendarOnly ? existing.verified : false,
      verificationStatus: isCalendarOnly ? existing.verificationStatus : 'pending_contact',
      calendarOnly: undefined,
      updatedAt: nowIso(),
      images: Array.isArray(clientPayload.images)
        ? clientPayload.images.filter((value) => typeof value === 'string' && value.startsWith('http'))
        : [],
      thumbnails: Array.isArray(clientPayload.thumbnails)
        ? clientPayload.thumbnails.filter((value) => typeof value === 'string' && value.startsWith('http'))
        : [],
      coverImage: (typeof clientPayload.coverImage === 'string' && clientPayload.coverImage.startsWith('http'))
        ? clientPayload.coverImage
        : '',
      specTable: sanitizeSpecTable(clientPayload.specTable),
    });
    const { data: listing, error } = await supabase
      .from('venues')
      .update(update)
      .eq('id', req.params.id)
      .eq('ownerId', ownerScopeId(req.auth))
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, message: 'Listing updated and returned to review.', listing: toListing(listing) });
  } catch (error) {
    return handleError(res, error);
  }
});

app.delete('/api/venues/:id', requireAuth, writeLimiter, async (req, res) => {
  try {
    const { data: deleted, error } = await supabase
      .from('venues')
      .delete()
      .eq('id', req.params.id)
      .eq('ownerId', req.auth.user.id)
      .select('id');
    if (error) throw error;
    if (!deleted || deleted.length === 0) {
      return res.status(404).json({ ok: false, message: 'Listing not found or not owned by you.' });
    }
    res.json({ ok: true, message: 'Listing removed.' });
  } catch (error) {
    return handleError(res, error);
  }
});

// CDN image upload proxy (client submits temp data: URLs here; backend uploads real compressed HD+thumb to Supabase)
// Returns public CDN URLs only. Uses service role (never exposed to Flutter).
// The configured public bucket is verified on every upload. If missing, a clear actionable error
// is returned telling the user exactly how to create it in the Supabase dashboard (one-time setup).
app.post('/api/cdn/upload', requireAuth, writeLimiter, async (req, res) => {
  try {
    if (!MOCK_CDN && !isSupabaseConfigured()) {
      const error = new Error('Supabase CDN is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
      error.status = 503;
      throw error;
    }

    const { dataUrl, size } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      const error = new Error('Missing or invalid dataUrl. Must be a data: URL from the image picker.');
      error.status = 400;
      throw error;
    }

    const ownerId = req.auth.user.id || 'anon';

    // Size-specific handling: 100px icons or logos
    if (size === '100' || size === 'logo') {
      const targetBucket = size === 'logo' ? LOGO_BUCKET : STORAGE_100_BUCKET;

      // Ensure target bucket exists and is public
      try {
        const { error: createErr } = await supabase.storage.createBucket(targetBucket, { public: true });
        if (createErr) {
          const msg = String(createErr.message || createErr || '').toLowerCase();
          if (!msg.includes('already exists') && !msg.includes('duplicate')) {
            console.warn(`[cdn/upload] Bucket '${targetBucket}' create warning:`, createErr.message || createErr);
          }
        }
      } catch (e) {
        console.warn(`[cdn/upload] Bucket '${targetBucket}' create attempt warning:`, e?.message || e);
      }

      // Verify the bucket exists
      let bucketExists = false;
      try {
        const { data, error: getErr } = await supabase.storage.getBucket(targetBucket);
        if (data && !getErr) bucketExists = true;
      } catch (_) {}
      if (!bucketExists) {
        const err = new Error(
          `Supabase bucket '${targetBucket}' does not exist.\n\n` +
          `FIX: Create a public bucket named '${targetBucket}' in your Supabase Dashboard → Storage → "New bucket".`
        );
        err.status = 503;
        throw err;
      }

      const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
      const mime = match[1].toLowerCase();
      const base64Str = match[2];
      const inputBuffer = Buffer.from(base64Str, 'base64');
      const resizedBuffer = await resizeTo100(inputBuffer);
      const ext = mime.includes('png') ? 'png' : 'jpg';
      const safeOwner = String(ownerId).replace(/[^a-z0-9_-]/gi, '');
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const basePath = `${safeOwner}/${ts}-${rand}`;
      const path = `${basePath}-100.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from(targetBucket)
        .upload(path, resizedBuffer, {
          contentType: 'image/jpeg',
          upsert: false,
          cacheControl: '31536000',
        });
      if (uploadErr) {
        const detail = uploadErr?.message || uploadErr?.error || JSON.stringify(uploadErr);
        throw new Error(`100px upload failed: ${detail}`);
      }

      const { data: pub } = supabase.storage.from(targetBucket).getPublicUrl(path);
      return res.json({ ok: true, message: 'Uploaded 100px image.', url: pub.publicUrl });
    }

    // Default: HD and thumbnail processing
    const { hd, thumb } = await processAndUploadToCdn(dataUrl, ownerId);

    // Also create and upload 100px icon for thumbnails/icons
    let iconUrl = '';
    try {
      const iconMatch = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
      if (iconMatch) {
        const iconBase64 = iconMatch[2];
        const iconBuffer = Buffer.from(iconBase64, 'base64');
        const iconResized = await resizeTo100(iconBuffer);
        const iconExt = iconMatch[1].toLowerCase().includes('png') ? 'png' : 'jpg';
        const safeOwner = String(ownerId).replace(/[^a-z0-9_-]/gi, '');
        const iconTs = Date.now();
        const iconRand = Math.random().toString(36).slice(2, 8);
        const iconPath = `${safeOwner}/${iconTs}-${iconRand}-100.${iconExt}`;

        const { error: iconUploadErr } = await supabase.storage
          .from(STORAGE_100_BUCKET)
          .upload(iconPath, iconResized, {
            contentType: 'image/jpeg',
            upsert: false,
            cacheControl: '31536000',
          });
        if (!iconUploadErr) {
          const { data: iconPub } = supabase.storage.from(STORAGE_100_BUCKET).getPublicUrl(iconPath);
          iconUrl = iconPub?.publicUrl || '';
        }
      }
    } catch (iconErr) {
      console.warn('[cdn/upload] 100px icon upload failed (non-fatal):', iconErr?.message || iconErr);
    }

    return res.json({ ok: true, message: 'Uploaded to Supabase CDN.', hd, thumb, icon: iconUrl });
  } catch (error) {
    return handleError(res, error);
  }
});

// Client bookings (own)
app.get('/api/bookings/mine', requireAuth, async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 12, 1, 50);
    const snap = await db.collection('bookings')
      .where('userId', '==', req.auth.user.id)
      .limit(limit)
      .get();
    const list = snap.docs.map(toBooking).sort((a, b) => (b.bookedAt || 0) - (a.bookedAt || 0));
    res.json({ ok: true, message: 'Bookings loaded.', bookings: list });
  } catch (error) {
    return handleError(res, error);
  }
});

app.post('/api/bookings', requireAuth, writeLimiter, async (req, res) => {
  try {
    // Minimal validation - full business rules (duplicate dates etc.) can be in main or payments
    const venueId = requireString(req.body.venueId, 'Venue');
    const eventDate = requireString(req.body.eventDate, 'Event date');
    const venueSnap = await db.collection('venues').doc(venueId).get();
    if (!venueSnap.exists) return res.status(404).json({ ok: false, message: 'Venue not found.' });
    const venue = toListing(venueSnap);
    if (venue.status !== 'approved') return res.status(400).json({ ok: false, message: 'Venue is not bookable yet.' });

    const ref = await db.collection('bookings').add({
      venueId,
      venueName: venue.name,
      customerName: req.auth.user.name,
      userId: req.auth.user.id,
      customerPhone: req.body.customerPhone || null,
      ownerId: venue.ownerId,
      eventDate,
      guests: req.body.guests || null,
      amount: req.body.amount ?? venue.priceWithGst ?? venue.basePrice ?? 0,
      status: 'pending',
      bookedAt: nowIso(),
    });
    const snap = await ref.get();
    res.status(201).json({ ok: true, message: 'Booking created. Complete payment to reserve.', booking: toBooking(snap) });
  } catch (error) {
    return handleError(res, error);
  }
});

// Payment proxy (same as main backend)
app.post('/api/payments/create-order', requireAuth, async (req, res) => {
  try {
    const response = await fetch(`${PAYMENTS_URL}/api/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, userId: req.auth.user.id }),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post('/api/payments/verify', requireAuth, async (req, res) => {
  try {
    const paymentType = String((req.body && req.body.type) || '').toLowerCase();
    const response = await fetch(`${PAYMENTS_URL}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, userId: req.auth.user.id }),
    });
    const data = await response.json();
    if (data && data.ok === true) {
      if (paymentType === 'premium' || paymentType === 'subscription' || paymentType === 'premium_listing') {
        const { error } = await supabase.from('profiles').update({
          is_premium: true,
          premium_since: nowIso(),
          last_payment_id: data.paymentId || req.body.razorpay_payment_id || null,
          updated_at: nowIso(),
        }).eq('id', req.auth.user.id);
        if (error) throw error;
        data.data = {
          ...(data.data || {}),
          isPremium: true,
          hasAccess: true,
        };
      }
    }
    res.status(response.status).json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

// Ad + premium (client self-service)
app.post('/api/access/grant-ad', requireAuth, writeLimiter, async (req, res) => {
  try {
    const TTL_MS = Number(process.env.AD_ACCESS_TTL_MS || 45 * 60 * 1000);
    const until = new Date(Date.now() + TTL_MS);
    const { error } = await supabase.from('profiles').update({
      ad_access_until: until.toISOString(),
      updated_at: nowIso(),
    }).eq('id', req.auth.user.id);
    if (error) throw error;
    res.json({ ok: true, message: 'Ad access granted.', data: { adAccessUntil: until.toISOString() } });
  } catch (error) {
    return handleError(res, error);
  }
});

app.post('/api/access/activate-premium', requireAuth, async (req, res) => {
  res.status(410).json({
    ok: false,
    message: 'Premium activation must be completed through verified payment.',
  });
});

// Profile (for manual location etc.)
app.get('/api/profiles/me', requireAuth, async (req, res) => {
  const profile = req.auth.profile || {};
  const manualLoc = profile.manualLocation || profile.manual_location || null;
  res.json({ ok: true, data: { user: req.auth.user, manual_location: manualLoc } });
});

app.patch('/api/profiles/me/location', requireAuth, async (req, res) => {
  try {
    const loc = req.body && (req.body.manual_location || req.body.manualLocation || null);
    const { error } = await supabase.from('profiles')
      .update({ manual_location: loc, updated_at: nowIso() })
      .eq('id', req.auth.user.id);
    if (error) throw error;
    res.json({ ok: true, message: 'Location saved.' });
  } catch (error) {
    return handleError(res, error);
  }
});

// Catch-all 404 for anything not exposed on client surface
app.use((req, res) => {
  res.status(404).json({ ok: false, message: 'Endpoint not available on client backend. Use main admin backend for privileged operations.' });
});

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    console.log(`Dvenue clientbackend running on http://localhost:${PORT} (client-only surface)`);
    console.log('Admin/staff privileged operations should use the main backend (port 4000 by default).');
  });

  server.on('error', (err) => {
    console.error('clientbackend server error', err);
  });
}

export default app;
