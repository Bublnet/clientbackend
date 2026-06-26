import sharp from 'sharp';
import supabaseDefault from './supabase.client.js';

/**
 * Image processor for CDN uploads.
 * Handles decoding base64 from picker, aggressive compression for large originals (5MB-50MB+),
 * producing high-quality HD (visible detail) + small thumb, then upload to Supabase public bucket.
 *
 * Design goals:
 * - Client picker already downsamples (1280px@72%), but server guarantees further optimization.
 * - For huge inputs: early downsample to protect memory and transfer size.
 * - HD: max 1600px, high visibility but good compression (mozjpeg + quality 82).
 * - Thumb: 480px square, very small for lists/cards.
 * - Final transfer: only tiny public URLs are sent in listing payload (not images).
 */

export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'bublnetorg';

// Toggle this to false when you have a real Supabase bucket configured.
export const MOCK_CDN = false;

/**
 * Resize input to HD version (good quality, web-friendly size).
 */
export async function resizeForHd(inputBuffer) {
  // Early aggressive downsample for very large originals (e.g. 50MB raw photos)
  // This ensures transfer stays reasonable even if client-side limits are bypassed.
  let workingBuffer = inputBuffer;
  if (inputBuffer.length > 4 * 1024 * 1024) {
    workingBuffer = await sharp(inputBuffer)
      .resize({ width: 2400, withoutEnlargement: true, fit: 'inside' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  }

  const hdBuffer = await sharp(workingBuffer)
    .resize({ width: 1600, withoutEnlargement: true, fit: 'inside' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  return hdBuffer;
}

/**
 * Resize input to thumbnail (fast loading cards/lists).
 */
export async function resizeForThumb(inputBuffer) {
  const thumbBuffer = await sharp(inputBuffer)
    .resize({ width: 480, height: 480, fit: 'inside' })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();

  return thumbBuffer;
}

/**
 * Core function: takes a data: URL (from Flutter picker), processes + uploads both versions.
 * Returns the public CDN URLs.
 *
 * supabaseClient param allows injection for unit tests (mock storage).
 */
export async function processAndUploadToCdn(dataUrl, ownerId = 'anon', supabaseClient = supabaseDefault) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('Invalid dataUrl');
  }

  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) {
    throw new Error('Unsupported image data format');
  }

  const mime = match[1].toLowerCase();
  const base64Str = match[2];
  let inputBuffer = Buffer.from(base64Str, 'base64');

  // Safety (server should also enforce higher in express.json)
  if (inputBuffer.length > 12 * 1024 * 1024) {
    throw new Error('Image too large even after client compression (max ~12MB decoded)');
  }

  if (MOCK_CDN && supabaseClient === supabaseDefault) {
    // MOCK: return real placeholder image URLs (picsum.photos always resolves to actual images).
    // This way mock mode shows visible placeholders instead of broken URLs.
    // The full listing data (mock URLs + specs/pricing per space + everything) is still sent to /api/venues.
    const mockSeed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      hd: `https://picsum.photos/seed/${mockSeed}-hd/1600/900`,
      thumb: `https://picsum.photos/seed/${mockSeed}-thumb/400/400`,
      hdSize: 0,
      thumbSize: 0,
      originalSize: inputBuffer.length,
    };
  }

  const bucket = STORAGE_BUCKET;

  // Best-effort auto-create (service role). Many projects hit RLS quirks on createBucket,
  // so we treat it as optional and do a hard existence check afterwards.
  try {
    const { error: createErr } = await supabaseClient.storage.createBucket(bucket, { public: true });
    if (createErr) {
      const msg = String(createErr.message || createErr || '').toLowerCase();
      if (!msg.includes('already exists') && !msg.includes('duplicate')) {
        console.warn('[image-processor] Bucket create warning (this is often harmless if you create it manually):', createErr.message || createErr);
      }
    }
  } catch (e) {
    console.warn('[image-processor] Bucket create attempt warning:', e?.message || e);
  }

  // Critical: verify the bucket actually exists. If not, give a crystal-clear instruction.
  let bucketExists = typeof supabaseClient.storage.getBucket !== 'function';
  if (!bucketExists) {
    try {
      const { data, error: getErr } = await supabaseClient.storage.getBucket(bucket);
      if (data && !getErr) {
        bucketExists = true;
      }
    } catch (_) {
      // ignore
    }
  }

  if (!bucketExists) {
    const helpful = new Error(
      `Supabase bucket '${bucket}' does not exist.\n\n` +
      `FIX (one-time):\n` +
      `1. Open your Supabase Dashboard\n` +
      `2. Go to Storage → "New bucket"\n` +
      `3. Name: ${bucket}\n` +
      `4. Toggle "Public bucket" ON\n` +
      `5. Create\n\n` +
      `Then restart the clientbackend (4002). Image uploads will then work.`
    );
    helpful.status = 503;
    throw helpful;
  }

  const ext = mime.includes('png') ? 'png' : 'jpg';
  const safeOwner = String(ownerId || 'anon').replace(/[^a-z0-9_-]/gi, '');
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const basePath = `${safeOwner}/${ts}-${rand}`;

  const hdPath = `${basePath}-hd.${ext}`;
  const thumbPath = `${basePath}-thumb.${ext}`;

  // Compress to HD (detailed but small) and thumb (tiny)
  const hdBuffer = await resizeForHd(inputBuffer);
  const thumbBuffer = await resizeForThumb(inputBuffer);

  // Uploads (public URLs)
  const { error: hdErr } = await supabaseClient.storage
    .from(bucket)
    .upload(hdPath, hdBuffer, {
      contentType: 'image/jpeg',
      upsert: false,
      cacheControl: '31536000',
    });
  if (hdErr) {
    const detail = hdErr?.message || hdErr?.error || JSON.stringify(hdErr);
    const lower = detail.toLowerCase();
    if (lower.includes('not found') || lower.includes('bucket')) {
      throw new Error(
        `HD upload failed because bucket '${bucket}' is missing. ` +
        `Please create the public bucket '${bucket}' in your Supabase Dashboard (Storage).`
      );
    }
    throw new Error(`HD upload failed: ${detail}`);
  }

  const { error: thErr } = await supabaseClient.storage
    .from(bucket)
    .upload(thumbPath, thumbBuffer, {
      contentType: 'image/jpeg',
      upsert: false,
      cacheControl: '31536000',
    });
  if (thErr) {
    const detail = thErr?.message || thErr?.error || JSON.stringify(thErr);
    const lower = detail.toLowerCase();
    if (lower.includes('not found') || lower.includes('bucket')) {
      throw new Error(
        `Thumb upload failed because bucket '${bucket}' is missing. ` +
        `Please create the public bucket '${bucket}' in your Supabase Dashboard (Storage).`
      );
    }
    throw new Error(`Thumb upload failed: ${detail}`);
  }

  const { data: hdPub } = supabaseClient.storage.from(bucket).getPublicUrl(hdPath);
  const { data: thPub } = supabaseClient.storage.from(bucket).getPublicUrl(thumbPath);

  return {
    hd: hdPub.publicUrl,
    thumb: thPub.publicUrl,
    // sizes for testing/observability
    hdSize: hdBuffer.length,
    thumbSize: thumbBuffer.length,
    originalSize: inputBuffer.length,
  };
}

export default {
  processAndUploadToCdn,
  resizeForHd,
  resizeForThumb,
};
