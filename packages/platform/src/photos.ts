import type { Pool } from '@auction/db';
import { LOT_RULES, type PhotoContentType } from '@auction/shared';
import type { S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import {
  EXTENSIONS,
  copyObject,
  deleteObject,
  getObjectBuffer,
  photoKeys,
  putObject,
  type S3Config,
} from './s3.js';

/**
 * Photo pipeline. The browser uploads straight to the PRIVATE bucket (presigned POST). This code
 * then takes the raw bytes and does not trust anything about them:
 *   - the real format is sniffed from the bytes (not the declared Content-Type or file name);
 *   - a pixel ceiling rejects decompression bombs before they are decoded;
 *   - the image is DECODED AND RE-ENCODED: EXIF (including GPS), XMP, ICC and any trailing or
 *     polyglot data do not survive, because only pixels are carried over;
 *   - orientation is applied first, so removing EXIF does not rotate the picture;
 *   - a 400 px WebP preview is produced.
 * The raw upload is deleted afterwards.
 */

/** 40 megapixels: bigger than any phone photo, far below a decompression bomb. */
export const MAX_PIXELS = 40_000_000;
export const PREVIEW_WIDTH = LOT_RULES.previewWidthPx;

const FORMAT_TO_TYPE: Readonly<Record<string, PhotoContentType>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export type ProcessedImage = {
  readonly full: Buffer;
  readonly preview: Buffer;
  readonly contentType: PhotoContentType;
  readonly width: number;
  readonly height: number;
};

export type ImageRejection =
  'not_an_image' | 'unsupported_format' | 'type_mismatch' | 'too_many_pixels' | 'too_large';

export const processImage = async (
  raw: Buffer,
  declaredType: PhotoContentType,
): Promise<{ ok: true; image: ProcessedImage } | { ok: false; reason: ImageRejection }> => {
  if (raw.length > LOT_RULES.maxPhotoBytes) return { ok: false, reason: 'too_large' };
  try {
    const probe = sharp(raw, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
    const meta = await probe.metadata();
    const sniffed: string | undefined = meta.format;
    // sharp's types say the format always exists, but it is absent for unrecognised input.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (sniffed === undefined) return { ok: false, reason: 'not_an_image' };
    const detected: PhotoContentType | undefined = FORMAT_TO_TYPE[sniffed];
    if (!detected) return { ok: false, reason: 'unsupported_format' };
    if (detected !== declaredType) return { ok: false, reason: 'type_mismatch' };
    if ((meta.pages ?? 1) > 1) return { ok: false, reason: 'unsupported_format' }; // animated

    const pipeline = () => sharp(raw, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate();
    const format = meta.format as 'jpeg' | 'png' | 'webp';
    // No `.withMetadata()`: sharp drops EXIF/XMP/ICC by default, which is exactly what we want.
    const full = await pipeline()
      .toFormat(format, { quality: 85 })
      .toBuffer({ resolveWithObject: true });
    const preview = await pipeline()
      .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    return {
      ok: true,
      image: {
        full: full.data,
        preview,
        contentType: detected,
        width: full.info.width,
        height: full.info.height,
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    if (/pixel limit|exceeds pixel/i.test(message)) return { ok: false, reason: 'too_many_pixels' };
    return { ok: false, reason: 'not_an_image' };
  }
};

export type PhotoProcessResult =
  | { status: 'ready' }
  | { status: 'rejected'; reason: ImageRejection }
  | { status: 'waiting' }
  | { status: 'skipped' };

/** How long a photo may stay `pending` without its upload showing up before it is rejected. */
export const UPLOAD_GRACE_MS = 60 * 60_000;

export const processUploadedPhoto = async (
  deps: { pool: Pool; s3: S3Client; config: S3Config; now: () => Date },
  photoId: string,
): Promise<PhotoProcessResult> => {
  const { rows } = await deps.pool.query<{
    id: string;
    lot_id: string;
    status: string;
    content_type: PhotoContentType;
    created_at: Date;
  }>(`SELECT id, lot_id, status, content_type, created_at FROM lot_photos WHERE id = $1`, [
    photoId,
  ]);
  const photo = rows[0];
  if (photo?.status !== 'pending') return { status: 'skipped' };

  const keys = photoKeys(photo.lot_id, photo.id);
  const raw = await getObjectBuffer(deps.s3, deps.config.privateBucket, keys.upload);
  if (!raw) {
    // The browser may still be uploading. Give up only after a long grace period.
    if (deps.now().getTime() - photo.created_at.getTime() > UPLOAD_GRACE_MS) {
      await deps.pool.query(
        `UPDATE lot_photos SET status = 'rejected' WHERE id = $1 AND status = 'pending'`,
        [photo.id],
      );
      return { status: 'rejected', reason: 'not_an_image' };
    }
    return { status: 'waiting' };
  }

  const result = await processImage(raw, photo.content_type);
  if (!result.ok) {
    await deps.pool.query(
      `UPDATE lot_photos SET status = 'rejected' WHERE id = $1 AND status = 'pending'`,
      [photo.id],
    );
    await deleteObject(deps.s3, deps.config.privateBucket, keys.upload);
    return { status: 'rejected', reason: result.reason };
  }

  const ext = EXTENSIONS[result.image.contentType];
  const fullKey = keys.full(ext);
  await putObject(
    deps.s3,
    deps.config.privateBucket,
    fullKey,
    result.image.full,
    result.image.contentType,
  );
  await putObject(
    deps.s3,
    deps.config.privateBucket,
    keys.preview,
    result.image.preview,
    'image/webp',
  );
  const done = await deps.pool.query(
    `UPDATE lot_photos SET status = 'ready', key = $2, preview_key = $3, size_bytes = $4
      WHERE id = $1 AND status = 'pending'`,
    [photo.id, fullKey, keys.preview, result.image.full.length],
  );
  if ((done.rowCount ?? 0) > 0) await deleteObject(deps.s3, deps.config.privateBucket, keys.upload);
  return { status: 'ready' };
};

const PUBLIC_STATUSES = [
  'active',
  'ended_unsold',
  'awaiting_payment',
  'paid',
  'shipped',
  'completed',
];

export type PublishReport = { readonly published: number; readonly unpublished: number };

/**
 * Makes the public bucket match the lot's visibility, idempotently:
 *   - lot is public (approved and not taken down) → processed photos are copied to the public
 *     bucket (once, tracked in `published_at`);
 *   - lot is not public (rejected, removed, back to draft) → public copies are deleted.
 * Photos of an unapproved lot are therefore never reachable without a signature.
 */
export const syncLotPhotos = async (
  deps: { pool: Pool; s3: S3Client; config: S3Config; now: () => Date },
  lotId: string,
): Promise<PublishReport> => {
  const lot = await deps.pool.query<{ status: string }>('SELECT status FROM lots WHERE id = $1', [
    lotId,
  ]);
  const status = lot.rows[0]?.status;
  if (!status) return { published: 0, unpublished: 0 };
  let published = 0;
  let unpublished = 0;

  if (PUBLIC_STATUSES.includes(status)) {
    const { rows } = await deps.pool.query<{ id: string; key: string; preview_key: string }>(
      `SELECT id, key, preview_key FROM lot_photos WHERE lot_id = $1 AND status = 'ready' AND published_at IS NULL`,
      [lotId],
    );
    for (const p of rows) {
      await copyObject(deps.s3, deps.config.privateBucket, deps.config.publicBucket, p.key);
      await copyObject(deps.s3, deps.config.privateBucket, deps.config.publicBucket, p.preview_key);
      const r = await deps.pool.query(
        `UPDATE lot_photos SET published_at = $2 WHERE id = $1 AND published_at IS NULL`,
        [p.id, deps.now()],
      );
      published += r.rowCount ?? 0;
    }
  } else {
    const { rows } = await deps.pool.query<{ id: string; key: string; preview_key: string | null }>(
      `SELECT id, key, preview_key FROM lot_photos WHERE lot_id = $1 AND published_at IS NOT NULL`,
      [lotId],
    );
    for (const p of rows) {
      await deleteObject(deps.s3, deps.config.publicBucket, p.key);
      if (p.preview_key) await deleteObject(deps.s3, deps.config.publicBucket, p.preview_key);
      const r = await deps.pool.query(`UPDATE lot_photos SET published_at = NULL WHERE id = $1`, [
        p.id,
      ]);
      unpublished += r.rowCount ?? 0;
    }
  }
  return { published, unpublished };
};

/** A generated placeholder picture (no text, so it needs no fonts): a coloured gradient with shapes. */
export const placeholderImage = async (n: number): Promise<Buffer> => {
  const hue = (n * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,35%)"/>
    </linearGradient></defs>
    <rect width="800" height="600" fill="url(#g)"/>
    <circle cx="${200 + (n % 5) * 80}" cy="${180 + (n % 3) * 60}" r="${90 + (n % 4) * 20}" fill="rgba(255,255,255,0.25)"/>
    <rect x="${420 - (n % 4) * 30}" y="${320 + (n % 2) * 40}" width="260" height="170" rx="22" fill="rgba(0,0,0,0.22)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
};

export const SEED_PLACEHOLDERS = 60;

/** Uploads the 60 placeholder pictures the seed refers to (`seed/p<N>/full.jpg`, `preview.jpg`). Idempotent. */
export const uploadSeedPlaceholders = async (
  s3: S3Client,
  config: S3Config,
  count = SEED_PLACEHOLDERS,
): Promise<number> => {
  for (let n = 0; n < count; n++) {
    const full = await placeholderImage(n);
    // The seed calls the preview ".jpg", so it is a small JPEG and the name tells the truth.
    const preview = await sharp(full)
      .resize({ width: PREVIEW_WIDTH })
      .jpeg({ quality: 78 })
      .toBuffer();
    for (const bucket of [config.privateBucket, config.publicBucket]) {
      await putObject(s3, bucket, `seed/p${n}/full.jpg`, full, 'image/jpeg');
      await putObject(s3, bucket, `seed/p${n}/preview.jpg`, preview, 'image/jpeg');
    }
  }
  return count;
};
