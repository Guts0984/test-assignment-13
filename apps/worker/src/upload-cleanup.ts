import { DeleteObjectCommand, ListObjectsV2Command, NoSuchBucket, type S3Client } from '@aws-sdk/client-s3';
import type { Pool } from '@auction/db';

/** A raw upload nobody will ever process is kept this long, then removed. */
export const UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const photoIdOf = (key: string): string | null => {
  const id = key.split('/')[2];
  return id !== undefined && UUID.test(id) ? id : null;
};

/**
 * Deletes objects under `uploads/` that are older than an hour and whose lot_photos row is not
 * pending any more (ready / rejected) or does not exist. A raw file swapped in after processing
 * would otherwise stay forever. Safe to run from every worker copy at once: deleting a missing
 * object is a no-op, and a pending row (or a recent object) is never touched.
 */
export const cleanupStaleUploads = async (
  s3: S3Client,
  pool: Pool,
  bucket: string,
  now: Date,
): Promise<number> => {
  const cutoff = now.getTime() - UPLOAD_MAX_AGE_MS;
  let deleted = 0;
  let token: string | undefined;
  do {
    let page;
    try {
      page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: 'uploads/', ContinuationToken: token }),
      );
    } catch (e) {
      if (e instanceof NoSuchBucket) return deleted; // buckets not created yet: nothing to clean
      throw e;
    }
    const old = (page.Contents ?? []).filter(
      (o): o is { Key: string; LastModified: Date } =>
        o.Key !== undefined && o.LastModified !== undefined && o.LastModified.getTime() < cutoff,
    );
    const ids = old.map((o) => photoIdOf(o.Key)).filter((id): id is string => id !== null);
    const pending = new Set(
      ids.length === 0
        ? []
        : (
            await pool.query<{ id: string }>(
              `SELECT id FROM lot_photos WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
              [ids],
            )
          ).rows.map((r) => r.id),
    );
    for (const o of old) {
      const id = photoIdOf(o.Key);
      if (id !== null && pending.has(id)) continue;
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }));
      deleted++;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return deleted;
};
