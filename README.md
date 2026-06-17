# Dvenue Client Backend (Isolated)

Client-only surface for production security.

## Purpose
- Client devices send their session (Firebase ID) token on requests.
- Server validates with Firebase Admin `verifyIdToken`. If valid and not expired/revoked, serves the user profile + (optionally) the token back.
- **Client tokens have no power for admin "set" operations** (approve listings, staff management, etc.). Those routes are **not mounted** here.
- Admin/staff privileged writes must use the main `backend/` server.

## Exposed (client-safe)
- Auth (login, direct/OTP signup, password reset email, /auth/validate, /auth/me, logout)
- Listings: public explore/search (gated), own /mine, submit own (POST /venues)
- Bookings: own /mine, create, pay (proxied)
- Self-service: ad grant, premium activate
- Profile: /profiles/me + location patch (for manual location sync)

## Run (dev)
- `cd clientbackend && npm install`
- `npm run dev` (or via root start.bat which launches it on 4002)
- Main admin backend stays on 4000.

## Production
- Deploy separately (smaller attack surface).
- Point pure client web/mobile traffic at this service.
- Main backend stays private or IP-restricted for admin users.
- Use same service account (or more restricted SA for clientbackend if you lock down Firestore rules + Admin usage).
- Environment variables control flags, CORS, rate limits (stricter recommended).

## Harmony with main backend
- Shares the same Firebase project + service account JSON (via env or ../backend/*.json).
- Keep common helpers (publicUser, ensure..., auth verification) in sync between the two folders.
- Frontend currently defaults to 4000 (full compat). For strict isolation switch client API calls to the clientbackend base URL.

## Token flow (as requested)
1. Client stores token from login response.
2. On app start / protected action: send token (header or body to /auth/validate).
3. Server: `auth.verifyIdToken(token, true)` — fails fast on expired/revoked.
4. If good → return profile (and token) so client can "serve"/continue the session.
5. Client tokens are ordinary user ID tokens; elevated roles are only honored for reads on this surface. Privileged writes are rejected by absence of routes + explicit role guards in main backend.

All previous security (rate limit, helmet, requirePremiumOrAd for reads, requireAuth, etc.) applies.

## Supabase CDN for images (new)
- `POST /api/cdn/upload` (auth + write limit): accepts a data: URL from the Flutter picker.
- Server (image-processor.js) handles early downsample for huge originals (5–50MB+), then produces:
  - HD: ~1600px max, high visual quality (mozjpeg q82) — full-HD look at small size.
  - Thumb: 480px, tiny for cards.
- Bucket `venue-images` (public) is auto-created on first upload.
- Only tiny public CDN URLs travel in the listing payload (never bytes after the upload step).
- **Unit tests**: `npm test` (in clientbackend) — see `test/image-processor.test.js`. Tests explicitly cover compression + "upload success" (mocked) for simulated large inputs, correct HD dimensions, and size reduction while preserving visibility.

See root README and main backend/ for full production notes.