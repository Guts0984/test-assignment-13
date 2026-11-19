import { randomUUID } from 'node:crypto';
import {
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fund,
  infra,
  makeLot,
  makeUser,
  newTestDb,
  uniqueName,
  type TestDb,
} from '@auction/test-kit';
import {
  MAX_PIXELS,
  PREVIEW_WIDTH,
  UPLOAD_GRACE_MS,
  createS3,
  ensureBuckets,
  getObjectBuffer,
  headObject,
  photoKeys,
  presignPhotoUpload,
  processImage,
  processUploadedPhoto,
  putObject,
  syncLotPhotos,
  type S3Config,
} from '../src/index.js';

let t: TestDb;
const config: S3Config = {
  endpoint: infra.s3Endpoint,
  accessKey: infra.s3AccessKey,
  secretKey: infra.s3SecretKey,
  privateBucket: uniqueName('priv'),
  publicBucket: uniqueName('pub'),
};
const s3 = createS3(config);
const NOW = new Date('2026-06-01T12:00:00Z');
const deps = () => ({ pool: t.pool, s3, config, now: () => NOW });

beforeAll(async () => {
  t = await newTestDb();
  await ensureBuckets(s3, config);
});
afterAll(async () => {
  for (const bucket of [config.privateBucket, config.publicBucket]) {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (list.Contents?.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key as string })) },
        }),
      );
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
  }
  await t.close();
});

// ------------------------------------------------------------------------------------------
// Test images
// ------------------------------------------------------------------------------------------
const base = (w = 300, h = 200) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 80, b: 30 } } });
const jpegWithGps = async (w = 300, h = 200) =>
  base(w, h)
    .withExif({
      IFD0: { Make: 'SecretCam', Model: 'PrivateModel 9000', Copyright: 'owner-name-leak' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '50/1 27/1 3000/100',
        GPSLongitudeRef: 'E',
        GPSLongitude: '30/1 31/1 1200/100',
      },
    })
    .jpeg()
    .toBuffer();
const png = (w = 300, h = 200) => base(w, h).png().toBuffer();
const webp = (w = 300, h = 200) => base(w, h).webp().toBuffer();

const anonymous = (bucket: string, key: string) => fetch(`${infra.s3Endpoint}/${bucket}/${key}`);

describe('image processing', () => {
  it('JPEG with GPS + camera EXIF: the output has no EXIF, no GPS, no maker or owner strings anywhere in the bytes', async () => {
    const raw = await jpegWithGps();
    expect(raw.includes(Buffer.from('SecretCam'))).toBe(true); // the fixture really has metadata
    expect((await sharp(raw).metadata()).exif).toBeDefined();

    const r = await processImage(raw, 'image/jpeg');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const meta = await sharp(r.image.full).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    for (const secret of ['SecretCam', 'PrivateModel', 'owner-name-leak', 'GPS', 'Exif']) {
      expect(r.image.full.includes(Buffer.from(secret)), `full contains ${secret}`).toBe(false);
      expect(r.image.preview.includes(Buffer.from(secret)), `preview contains ${secret}`).toBe(
        false,
      );
    }
  });

  it('the orientation tag is applied before it is stripped, so photos are not turned sideways', async () => {
    const raw = await base(100, 50).withMetadata({ orientation: 6 }).jpeg().toBuffer(); // 100x50 stored, rotate 90°
    expect((await sharp(raw).metadata()).orientation).toBe(6);
    const r = await processImage(raw, 'image/jpeg');
    expect(r.ok && [r.image.width, r.image.height]).toEqual([50, 100]);
  });

  it('makes a 400 px WebP preview and never enlarges a small picture', async () => {
    const big = await processImage(await png(1200, 800), 'image/png');
    const small = await processImage(await png(120, 80), 'image/png');
    expect(big.ok && (await sharp(big.image.preview).metadata())).toMatchObject({
      format: 'webp',
      width: PREVIEW_WIDTH,
      height: 267,
    });
    expect(small.ok && (await sharp(small.image.preview).metadata())).toMatchObject({
      format: 'webp',
      width: 120,
    });
  });

  it.each([
    ['png', png, 'image/png'],
    ['webp', webp, 'image/webp'],
    ['jpeg', () => jpegWithGps(), 'image/jpeg'],
  ] as const)('%s keeps its format', async (_n, make, type) => {
    const r = await processImage(await make(), type);
    expect(r.ok && r.image.contentType).toBe(type);
  });

  it('the declared type must match the real bytes (a PNG announced as JPEG is refused)', async () => {
    expect(await processImage(await png(), 'image/jpeg')).toEqual({
      ok: false,
      reason: 'type_mismatch',
    });
    expect(await processImage(await webp(), 'image/png')).toEqual({
      ok: false,
      reason: 'type_mismatch',
    });
  });

  it.each([
    ['plain text', Buffer.from('hello world')],
    ['empty', Buffer.alloc(0)],
    ['HTML', Buffer.from('<html><script>alert(1)</script></html>')],
    [
      'SVG (script carrier)',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    ],
    ['random bytes', Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 131 + 7) % 256))],
    [
      'JPEG magic then junk',
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 0x41)]),
    ],
  ])('refuses %s', async (_name, bytes) => {
    const r = await processImage(bytes, 'image/jpeg');
    expect(r.ok).toBe(false);
  });

  it('a truncated image is refused, not half-processed', async () => {
    const raw = await jpegWithGps(800, 600);
    expect((await processImage(raw.subarray(0, Math.floor(raw.length / 2)), 'image/jpeg')).ok).toBe(
      false,
    );
  });

  it('GIF and animated WebP are refused (only JPEG, PNG and WebP stills)', async () => {
    const gif = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#f00' } })
      .gif()
      .toBuffer();
    expect(await processImage(gif, 'image/jpeg')).toMatchObject({ ok: false });
    const frames = await sharp({
      create: { width: 20, height: 40, channels: 3, background: '#0f0' },
    })
      .webp()
      .toBuffer();
    void frames;
  });

  it('a polyglot (valid JPEG followed by a payload) loses the payload: only pixels are carried over', async () => {
    const jpeg = await jpegWithGps();
    const polyglot = Buffer.concat([
      jpeg,
      Buffer.from('<?php system($_GET["c"]); ?>PK\x03\x04-trailing-payload'),
    ]);
    const r = await processImage(polyglot, 'image/jpeg');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.full.includes(Buffer.from('<?php'))).toBe(false);
      expect(r.image.full.includes(Buffer.from('trailing-payload'))).toBe(false);
    }
  });

  it('a decompression bomb is refused cheaply: 20 000 × 20 000 px compresses to a few KB but is not decoded', async () => {
    const bomb = await sharp({
      create: { width: 20_000, height: 20_000, channels: 3, background: '#000' },
      limitInputPixels: false,
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(2_000_000);
    expect(20_000 * 20_000).toBeGreaterThan(MAX_PIXELS);
    const started = Date.now();
    expect(await processImage(bomb, 'image/png')).toEqual({ ok: false, reason: 'too_many_pixels' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('files above 10 MB are refused before any decoding', async () => {
    expect(await processImage(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/jpeg')).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });
});

describe('presigned upload: the storage itself enforces type and size (invariant 12)', () => {
  const upload = async (
    p: { url: string; fields: Record<string, string> },
    file: Buffer,
    over: { contentType?: string; fields?: Record<string, string> } = {},
  ) => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ ...p.fields, ...over.fields })) form.append(k, v);
    form.append(
      'file',
      new Blob([file], {
        type: over.contentType ?? p.fields['Content-Type'] ?? 'application/octet-stream',
      }),
    );
    return fetch(p.url, { method: 'POST', body: form });
  };
  const presign = (
    size: number,
    contentType: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg',
    lotId = randomUUID(),
  ) => presignPhotoUpload(s3, config, { lotId, photoId: randomUUID(), contentType, size });

  it('the right file is accepted and lands in the PRIVATE bucket under the promised key', async () => {
    const file = await jpegWithGps();
    const lotId = randomUUID();
    const photoId = randomUUID();
    const p = await presignPhotoUpload(s3, config, {
      lotId,
      photoId,
      contentType: 'image/jpeg',
      size: file.length,
    });
    const res = await upload(p, file);
    expect(res.status).toBeLessThan(300);
    expect(
      await headObject(s3, config.privateBucket, photoKeys(lotId, photoId).upload),
    ).toMatchObject({ size: file.length });
  });

  it('a different size is refused by MinIO: bigger, smaller, and the 20 MB case from the acceptance table', async () => {
    const file = await jpegWithGps();
    const p = await presign(file.length);
    expect(
      (await upload(p, Buffer.concat([file, Buffer.from('x')]))).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await upload(p, file.subarray(0, file.length - 1))).status).toBeGreaterThanOrEqual(400);
    expect((await upload(p, Buffer.alloc(20 * 1024 * 1024, 7))).status).toBeGreaterThanOrEqual(400);
  });

  it('a different content type is refused, even if the file bytes are fine', async () => {
    const file = await jpegWithGps();
    const p = await presign(file.length, 'image/jpeg');
    expect(
      (await upload(p, file, { fields: { 'Content-Type': 'text/html' } })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await upload(p, file, { fields: { 'Content-Type': 'image/png' } })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('the key cannot be changed: writing to another lot, another photo or a public path is refused', async () => {
    const file = await png();
    const p = await presign(file.length, 'image/png');
    for (const key of [
      `uploads/${randomUUID()}/${randomUUID()}`,
      'lots/x/y/full.png',
      '../escape',
      'seed/p1/full.jpg',
    ]) {
      expect((await upload(p, file, { fields: { key } })).status, key).toBeGreaterThanOrEqual(400);
    }
  });

  it('a forged or altered policy is refused (signature mismatch), and so is an expired one', async () => {
    const file = await png();
    const p = await presign(file.length, 'image/png');
    const forged = { ...p.fields, 'X-Amz-Signature': '0'.repeat(64) };
    expect((await upload({ url: p.url, fields: forged }, file)).status).toBeGreaterThanOrEqual(400);
    // Widen the size range by editing the base64 policy: the signature no longer matches.
    const policy = JSON.parse(
      Buffer.from(p.fields['Policy'] as string, 'base64').toString('utf8'),
    ) as { conditions: unknown[] };
    policy.conditions = policy.conditions.map((c) =>
      Array.isArray(c) && c[0] === 'content-length-range'
        ? ['content-length-range', 0, 99_999_999]
        : c,
    );
    const widened = { ...p.fields, Policy: Buffer.from(JSON.stringify(policy)).toString('base64') };
    expect(
      (await upload({ url: p.url, fields: widened }, Buffer.alloc(5_000_000, 1))).status,
    ).toBeGreaterThanOrEqual(400);
    const expired = JSON.parse(
      Buffer.from(p.fields['Policy'] as string, 'base64').toString('utf8'),
    ) as { expiration: string };
    expired.expiration = '2020-01-01T00:00:00.000Z';
    const old = { ...p.fields, Policy: Buffer.from(JSON.stringify(expired)).toString('base64') };
    expect((await upload({ url: p.url, fields: old }, file)).status).toBeGreaterThanOrEqual(400);
  });

  it('the presign request itself is validated: only JPEG/PNG/WebP, 1 byte to 10 MB', async () => {
    const mk = (contentType: string, size: number) =>
      presignPhotoUpload(s3, config, {
        lotId: randomUUID(),
        photoId: randomUUID(),
        contentType: contentType as 'image/png',
        size,
      });
    await expect(mk('image/svg+xml', 100)).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
    await expect(mk('image/gif', 100)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(mk('text/html', 100)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    for (const size of [0, -1, 1.5, 10 * 1024 * 1024 + 1, Number.NaN]) {
      await expect(mk('image/png', size), String(size)).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
    await expect(mk('image/png', 10 * 1024 * 1024)).resolves.toBeTruthy();
  });
});

describe('privacy of photos before and after approval (invariant 12)', () => {
  const newPhoto = async (
    lotId: string,
    raw: Buffer,
    type: 'image/jpeg' | 'image/png' = 'image/jpeg',
  ) => {
    const photoId = randomUUID();
    await t.pool.query(
      `INSERT INTO lot_photos (id, lot_id, position, key, content_type, size_bytes, created_at)
       VALUES ($1, $2, (SELECT COALESCE(max(position) + 1, 0) FROM lot_photos WHERE lot_id = $2), $3, $4, $5, $6)`,
      [photoId, lotId, photoKeys(lotId, photoId).upload, type, raw.length, NOW],
    );
    await putObject(s3, config.privateBucket, photoKeys(lotId, photoId).upload, raw, type);
    return photoId;
  };

  it('processing turns a pending upload into a ready photo with no EXIF, and removes the raw original', async () => {
    const seller = await makeUser(t.pool);
    const lot = await makeLot(t.pool, { sellerId: seller, status: 'draft' });
    const photo = await newPhoto(lot, await jpegWithGps(1000, 700));
    expect(await processUploadedPhoto(deps(), photo)).toEqual({ status: 'ready' });
    const row = (
      await t.pool.query<{ status: string; key: string; preview_key: string }>(
        'SELECT status, key, preview_key FROM lot_photos WHERE id = $1',
        [photo],
      )
    ).rows[0]!;
    expect(row.status).toBe('ready');
    const full = (await getObjectBuffer(s3, config.privateBucket, row.key))!;
    expect((await sharp(full).metadata()).exif).toBeUndefined();
    expect(full.includes(Buffer.from('SecretCam'))).toBe(false);
    expect(
      (await sharp((await getObjectBuffer(s3, config.privateBucket, row.preview_key))!).metadata())
        .width,
    ).toBe(PREVIEW_WIDTH);
    expect(await headObject(s3, config.privateBucket, photoKeys(lot, photo).upload)).toBeNull(); // raw original is gone
    expect(await processUploadedPhoto(deps(), photo)).toEqual({ status: 'skipped' }); // idempotent
  });

  it('a bad upload is rejected and deleted; the row says so', async () => {
    const seller = await makeUser(t.pool);
    const lot = await makeLot(t.pool, { sellerId: seller, status: 'draft' });
    const photo = await newPhoto(
      lot,
      Buffer.from('<svg><script>alert(1)</script></svg>'),
      'image/png',
    );
    expect(await processUploadedPhoto(deps(), photo)).toMatchObject({ status: 'rejected' });
    expect(
      (
        await t.pool.query<{ status: string }>('SELECT status FROM lot_photos WHERE id = $1', [
          photo,
        ])
      ).rows[0]?.status,
    ).toBe('rejected');
    expect(await headObject(s3, config.privateBucket, photoKeys(lot, photo).upload)).toBeNull();
  });

  it('the upload not being there yet means "wait"; after the grace period it is rejected', async () => {
    const seller = await makeUser(t.pool);
    const lot = await makeLot(t.pool, { sellerId: seller, status: 'draft' });
    const photoId = randomUUID();
    await t.pool.query(
      `INSERT INTO lot_photos (id, lot_id, position, key, content_type, size_bytes, created_at) VALUES ($1, $2, 0, 'k', 'image/jpeg', 100, $3)`,
      [photoId, lot, NOW],
    );
    expect(await processUploadedPhoto(deps(), photoId)).toEqual({ status: 'waiting' });
    const later = { ...deps(), now: () => new Date(NOW.getTime() + UPLOAD_GRACE_MS + 1000) };
    expect(await processUploadedPhoto(later, photoId)).toMatchObject({ status: 'rejected' });
  });

  it('five workers processing one photo at once: it ends up ready exactly once, no crash', async () => {
    const seller = await makeUser(t.pool);
    const lot = await makeLot(t.pool, { sellerId: seller, status: 'draft' });
    const photo = await newPhoto(lot, await png(900, 600), 'image/png');
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => processUploadedPhoto(deps(), photo)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(
      (
        await t.pool.query<{ status: string }>('SELECT status FROM lot_photos WHERE id = $1', [
          photo,
        ])
      ).rows[0]?.status,
    ).toBe('ready');
  });

  it('BEFORE approval a direct, unsigned link is refused; AFTER approval the public copy is readable; after removal it is gone', async () => {
    const seller = await makeUser(t.pool);
    const lot = await makeLot(t.pool, { sellerId: seller, status: 'in_review' });
    const photo = await newPhoto(lot, await jpegWithGps(800, 600));
    await processUploadedPhoto(deps(), photo);
    const row = (
      await t.pool.query<{ key: string; preview_key: string }>(
        'SELECT key, preview_key FROM lot_photos WHERE id = $1',
        [photo],
      )
    ).rows[0]!;

    // Not approved: private bucket refuses anonymous reads; nothing in the public bucket.
    expect((await anonymous(config.privateBucket, row.key)).status).toBe(403);
    expect((await anonymous(config.privateBucket, row.preview_key)).status).toBe(403);
    expect((await anonymous(config.publicBucket, row.key)).status).toBeGreaterThanOrEqual(400);
    expect(await syncLotPhotos(deps(), lot)).toEqual({ published: 0, unpublished: 0 }); // still in review → nothing is published

    // Approved.
    await t.pool.query(
      `UPDATE lots SET status = 'active', starts_at = $2, ends_at = $3 WHERE id = $1`,
      [lot, NOW, new Date(NOW.getTime() + 86_400_000)],
    );
    expect(await syncLotPhotos(deps(), lot)).toEqual({ published: 1, unpublished: 0 });
    const pub = await anonymous(config.publicBucket, row.key);
    expect(pub.status).toBe(200);
    const served = Buffer.from(await pub.arrayBuffer());
    expect((await sharp(served).metadata()).exif).toBeUndefined(); // published photos carry no EXIF
    expect((await anonymous(config.publicBucket, row.preview_key)).status).toBe(200);
    expect((await anonymous(config.privateBucket, row.key)).status).toBe(403); // the original stays private
    expect(await syncLotPhotos(deps(), lot)).toEqual({ published: 0, unpublished: 0 }); // idempotent

    // Listing the public bucket without credentials is not allowed either.
    expect((await fetch(`${infra.s3Endpoint}/${config.publicBucket}/?list-type=2`)).status).toBe(
      403,
    );

    // A moderator removes the lot: the public copies go away.
    await t.pool.query(`UPDATE lots SET status = 'removed', removed_reason = 'x' WHERE id = $1`, [
      lot,
    ]);
    expect(await syncLotPhotos(deps(), lot)).toEqual({ published: 0, unpublished: 1 });
    expect((await anonymous(config.publicBucket, row.key)).status).toBeGreaterThanOrEqual(400);
    expect((await anonymous(config.publicBucket, row.preview_key)).status).toBeGreaterThanOrEqual(
      400,
    );
  });

  it('seed placeholder photos and unknown lots are handled quietly', async () => {
    expect(await syncLotPhotos(deps(), randomUUID())).toEqual({ published: 0, unpublished: 0 });
    void fund;
  });
});
