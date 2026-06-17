import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import dotenv from 'dotenv';
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
import { processAndUploadToCdn, MOCK_CDN } from './image-processor.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4002;
const PAYMENTS_URL = process.env.PAYMENTS_SERVICE_URL || 'http://localhost:4001';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const DEFAULT_ADMIN_EMAIL = process.env.DEFAULT_ADMIN_EMAIL;

const AUTH_OTP_TTL_MS = Number(process.env.AUTH_OTP_TTL_MS || 10 * 60 * 1000);
const authBaseUrl = `https://identitytoolkit.googleapis.com/v1/accounts`;

const ENABLE_OTP_VERIFY = (process.env.ENABLE_OTP_VERIFY || 'false').toLowerCase() === 'true';
const ENABLE_GOOGLE_SIGNIN = (process.env.ENABLE_GOOGLE_SIGNIN || 'false').toLowerCase() === 'true';

initFirebaseAdmin();

if (isSupabaseConfigured()) {
  console.log('[clientbackend] Supabase CDN configured for image uploads.');
  console.log('[clientbackend] NOTE: You must create the PUBLIC "venue-images" bucket once in your Supabase Dashboard (Storage).');
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
  if (!FIREBASE_API_KEY) {
    const error = new Error('Firebase API key is not configured.');
    error.status = 500;
    throw error;
  }
  const response = await fetch(`${authBaseUrl}:${action}?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(mapFirebaseAuthError(data?.error?.message));
    error.status = 400;
    throw error;
  }
  return data;
}

function mapFirebaseAuthError(code) {
  switch (code) {
    case 'EMAIL_EXISTS': return 'An account already exists for this email.';
    case 'EMAIL_NOT_FOUND':
    case 'INVALID_PASSWORD':
    case 'INVALID_LOGIN_CREDENTIALS':
      return 'Invalid login credentials.';
    case 'WEAK_PASSWORD : Password should be at least 6 characters':
    case 'WEAK_PASSWORD':
      return 'Password must be at least 6 characters.';
    default: return 'Authentication failed.';
  }
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
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (snap.exists) return { id: uid, ...snap.data() };
  return { id: uid };
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
    role: profile.role || 'client',
    isPremium: profile.isPremium === true || profile.is_premium === true,
    adAccessUntil: profile.adAccessUntil || profile.ad_access_until || null,
  };
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

    // Verify with Firebase Admin (works for both dev/prod)
    const decoded = await auth.verifyIdToken(idToken, true); // checkRevoked for safety

    // If token is expired or revoked, verifyIdToken throws
    const profile = await ensureUserProfile(decoded.uid, {
      email: decoded.email,
      identifier: decoded.email,
      name: decoded.name || decoded.email?.split('@')[0] || 'User',
    });

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
  const hasAccess = isPremium || ['admin', 'manager', 'support', 'reviewer'].includes(role) || (adAccessUntil && adAccessUntil.getTime() > Date.now());

  if (!hasAccess) {
    return res.status(402).json({
      ok: false,
      message: 'Premium subscription or ad watch required for this action.',
      code: 'ACCESS_REQUIRED',
    });
  }
  next();
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
  res.json({ ok: true, message: 'Logged out.' });
});

// --- Client data routes (read + limited own writes). 
// Client submits listings (full details + Supabase CDN image URLs) here for verification.
// Admin "set" operations (approve/reject on pending, which makes verified data available
// for public queries + bookings on BOTH surfaces) live only on main backend/. ---

// Explore / search (gated by premium/ad for full access)
app.get('/api/venues/explore', requireAuth, requirePremiumOrAd, async (req, res) => {
  try {
    const { data: venues, error } = await supabase
      .from('venues')
      .select('*')
      .eq('status', 'approved');
      
    if (error) throw error;
    const formattedVenues = venues.map(toListing);
    res.json({ ok: true, message: 'Venues loaded.', venues: formattedVenues, nearby: formattedVenues, all: formattedVenues });
  } catch (error) {
    return handleError(res, error);
  }
});

app.get('/api/venues/search', requireAuth, requirePremiumOrAd, async (req, res) => {
  try {
    const { data: results, error } = await supabase
      .from('venues')
      .select('*')
      .eq('status', 'approved');
      
    if (error) throw error;
    res.json({ ok: true, message: 'Search complete.', results: results.map(toListing) });
  } catch (error) {
    return handleError(res, error);
  }
});

app.get('/api/venues/:id', requireAuth, requirePremiumOrAd, async (req, res) => {
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
    return res.json({ ok: true, listing: formattedListing });
  } catch (error) {
    return handleError(res, error);
  }
});

// Owner's own listings (client can see their submissions)
app.get('/api/venues/mine', requireAuth, async (req, res) => {
  try {
    const { data: listings, error } = await supabase
      .from('venues')
      .select('*')
      .eq('ownerId', req.auth.user.id);
      
    if (error) throw error;
    res.json({ ok: true, message: 'Listings loaded.', listings: listings.map(toListing) });
  } catch (error) {
    return handleError(res, error);
  }
});

// Admin pending (fetched by main admin backend for verification flow)
app.get('/api/venues/admin/pending', requireAuth, async (req, res) => {
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

// CDN image upload proxy (client submits temp data: URLs here; backend uploads real compressed HD+thumb to Supabase)
// Returns public CDN URLs only. Uses service role (never exposed to Flutter).
// The 'venue-images' public bucket is verified on every upload. If missing, a clear actionable error
// is returned telling the user exactly how to create it in the Supabase dashboard (one-time setup).
app.post('/api/cdn/upload', requireAuth, writeLimiter, async (req, res) => {
  try {
    if (!MOCK_CDN && !isSupabaseConfigured()) {
      const error = new Error('Supabase CDN is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
      error.status = 503;
      throw error;
    }

    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      const error = new Error('Missing or invalid dataUrl. Must be a data: URL from the image picker.');
      error.status = 400;
      throw error;
    }

    const ownerId = req.auth.user.id || 'anon';

    // Delegate to processor: handles decode, early downsample for huge originals,
    // HD (detailed yet compressed) + thumb, bucket existence check (with clear instructions if missing),
    // and Supabase upload. Only tiny public CDN URLs are returned for the listing payload.
    const { hd, thumb } = await processAndUploadToCdn(dataUrl, ownerId);

    return res.json({
      ok: true,
      message: 'Uploaded to Supabase CDN.',
      hd,
      thumb,
    });
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
      amount: venue.priceWithGst || venue.basePrice || 0,
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
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    return handleError(res, error);
  }
});

app.post('/api/payments/verify', requireAuth, async (req, res) => {
  try {
    const response = await fetch(`${PAYMENTS_URL}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (data && data.ok === true) {
      // On successful payment, client can also hit activate-premium if applicable
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
    const ref = db.collection('users').doc(req.auth.user.id);
    await ref.set({
      adAccessUntil: until.toISOString(),
      adAccessGrantedAt: nowIso(),
      updatedAt: nowIso(),
    }, { merge: true });
    res.json({ ok: true, message: 'Ad access granted.', data: { adAccessUntil: until.toISOString() } });
  } catch (error) {
    return handleError(res, error);
  }
});

app.post('/api/access/activate-premium', requireAuth, async (req, res) => {
  try {
    await db.collection('users').doc(req.auth.user.id).set({
      isPremium: true,
      premiumSince: nowIso(),
      updatedAt: nowIso(),
    }, { merge: true });
    res.json({ ok: true, message: 'Premium activated.', data: { isPremium: true } });
  } catch (error) {
    return handleError(res, error);
  }
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
    await db.collection('users').doc(req.auth.user.id).set({
      manualLocation: loc,
      manual_location: loc,
      updatedAt: nowIso(),
    }, { merge: true });
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