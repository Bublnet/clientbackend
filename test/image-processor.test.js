import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { processAndUploadToCdn, resizeForHd, resizeForThumb } from '../image-processor.js';

// Mock supabase storage client for unit tests (no real network/credentials needed)
function createMockSupabase() {
  const uploaded = [];
  return {
    storage: {
      async createBucket(name, opts) {
        // simulate success or "already exists"
        return { error: null };
      },
      from(bucket) {
        return {
          async upload(path, buffer, options) {
            uploaded.push({ bucket, path, size: buffer.length, contentType: options?.contentType });
            return { error: null };
          },
          getPublicUrl(path) {
            return {
              data: {
                publicUrl: `https://mock.supabase.co/storage/v1/object/public/${bucket}/${path}`,
              },
            };
          },
        };
      },
    },
    // for test inspection
    _getUploaded() { return uploaded; },
    _reset() { uploaded.length = 0; },
  };
}

describe('image-processor (CDN compression + upload)', () => {
  let mockSupabase;

  before(() => {
    mockSupabase = createMockSupabase();
  });

  after(() => {
    // nothing
  });

  test('resizeForHd produces much smaller output and respects HD max dimension', async () => {
    // Simulate a "large" (high-res) original, e.g. 50MB phone photo downsampled by picker but still big
    const largeOriginal = await sharp({
      create: {
        width: 5000,
        height: 4000,
        channels: 3,
        background: { r: 200, g: 100, b: 50 },
      },
    })
      .jpeg({ quality: 92 })
      .toBuffer();

    const hd = await resizeForHd(largeOriginal);

    // Compression: output should be dramatically smaller than a naive high-quality version
    assert.ok(hd.length < largeOriginal.length * 0.6, 'HD version should be significantly compressed');

    const meta = await sharp(hd).metadata();
    assert.ok(meta.width <= 1600, 'HD width must not exceed 1600px');
    assert.ok(meta.format === 'jpeg', 'HD must be jpeg');
  });

  test('resizeForThumb produces very small output suitable for lists', async () => {
    const largeOriginal = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: 'blue' },
    }).jpeg().toBuffer();

    const thumb = await resizeForThumb(largeOriginal);

    const meta = await sharp(thumb).metadata();
    assert.ok(meta.width <= 480 && meta.height <= 480, 'Thumb must be <= 480px');
    assert.ok(thumb.length < 80 * 1024, 'Thumb should be tiny (<80KB for test image)');
  });

  test('processAndUploadToCdn handles "large" (5MB-50MB class) input, compresses, returns public URLs, and calls upload', async () => {
    mockSupabase._reset();

    // Create a realistically large input buffer (simulates 5-50MB original after picker or direct)
    const bigInput = await sharp({
      create: {
        width: 6000,
        height: 4500,
        channels: 3,
        background: { r: 30, g: 60, b: 120 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Turn into data URL like the Flutter side sends
    const dataUrl = `data:image/jpeg;base64,${bigInput.toString('base64')}`;

    const result = await processAndUploadToCdn(dataUrl, 'test-owner-123', mockSupabase);

    // Must return usable public CDN URLs (used in listing payload)
    assert.ok(result.hd && result.hd.startsWith('https://mock.supabase.co'), 'hd must be public Supabase URL');
    assert.ok(result.thumb && result.thumb.startsWith('https://mock.supabase.co'), 'thumb must be public Supabase URL');

    // Compression evidence: both outputs much smaller than the (simulated large) input
    assert.ok(result.hdSize < bigInput.length * 0.5, 'HD payload size should be heavily reduced');
    assert.ok(result.thumbSize < 100 * 1024, 'Thumb payload must be very small');

    // Verify the mock "upload" was performed twice (HD + thumb)
    const uploads = mockSupabase._getUploaded();
    assert.strictEqual(uploads.length, 2, 'exactly two uploads (hd + thumb) should have been attempted');
    assert.ok(uploads[0].path.includes('-hd.'), 'first upload should be the HD version');
    assert.ok(uploads[1].path.includes('-thumb.'), 'second upload should be the thumb version');
    assert.ok(uploads.every(u => u.bucket === 'bublnetorg'), 'must target the correct bucket');
  });

  test('processAndUploadToCdn rejects invalid dataUrl early', async () => {
    await assert.rejects(
      () => processAndUploadToCdn('not-a-data-url', 'owner', mockSupabase),
      /Invalid dataUrl/
    );
  });

  test('early downsample + final resize keeps memory/transfer reasonable for huge inputs', async () => {
    // This simulates what happens with a true 50MB original that somehow reached the server
    const huge = await sharp({
      create: { width: 8000, height: 6000, channels: 3, background: 'green' },
    })
      .jpeg({ quality: 95 })
      .toBuffer();

    const hd = await resizeForHd(huge);
    const thumb = await resizeForThumb(huge);

    // Even starting from a giant synthetic image, outputs stay small
    assert.ok(hd.length < 1.5 * 1024 * 1024, 'HD from huge input should still be < ~1.5MB');
    assert.ok(thumb.length < 60 * 1024, 'thumb from huge input must stay tiny');
  });
});
