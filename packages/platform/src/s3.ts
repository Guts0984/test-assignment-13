import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { LOT_RULES, appError, type PhotoContentType } from '@auction/shared';

export type S3Config = {
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly privateBucket: string;
  readonly publicBucket: string;
};

export const createS3 = (
  config: Pick<S3Config, 'endpoint' | 'accessKey' | 'secretKey'>,
): S3Client =>
  new S3Client({
    endpoint: config.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    maxAttempts: 3,
  });

const statusOf = (e: unknown): number | undefined =>
  (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

const bucketExists = async (s3: S3Client, bucket: string): Promise<boolean> => {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (e) {
    if (statusOf(e) === 404 || (e as { name?: string }).name === 'NotFound') return false;
    throw e;
  }
};

/**
 * Creates both buckets (idempotent). The PRIVATE bucket gets no policy at all: without a
 * signature every request is refused. The PUBLIC bucket allows anonymous GET of objects (no
 * listing), and only ever receives photos of approved lots.
 */
export const ensureBuckets = async (s3: S3Client, config: S3Config): Promise<void> => {
  for (const bucket of [config.privateBucket, config.publicBucket]) {
    if (!(await bucketExists(s3, bucket)))
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${config.publicBucket}/*`],
      },
    ],
  };
  await s3.send(
    new PutBucketPolicyCommand({ Bucket: config.publicBucket, Policy: JSON.stringify(policy) }),
  );
};

export const photoKeys = (lotId: string, photoId: string) => ({
  upload: `uploads/${lotId}/${photoId}`,
  full: (ext: string) => `lots/${lotId}/${photoId}/full.${ext}`,
  preview: `lots/${lotId}/${photoId}/preview.webp`,
});

export const EXTENSIONS: Readonly<Record<PhotoContentType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const PRESIGN_TTL_SECONDS = 300;

export type PresignedUpload = {
  readonly url: string;
  readonly fields: Record<string, string>;
  readonly photoId: string;
  readonly expiresInSeconds: number;
};

/**
 * A presigned POST that accepts exactly ONE file: this key, this Content-Type and exactly this
 * many bytes. MinIO itself enforces the policy, so a different type, a bigger or smaller file, or
 * another key is refused by the storage, not by our code. (A POST policy is signed over its
 * conditions, not over the host, so the browser may use any public hostname.)
 */
export const presignPhotoUpload = async (
  s3: S3Client,
  config: S3Config,
  input: { lotId: string; photoId: string; contentType: PhotoContentType; size: number },
): Promise<PresignedUpload> => {
  if (!(LOT_RULES.photoContentTypes as readonly string[]).includes(input.contentType)) {
    throw appError('UNSUPPORTED_MEDIA_TYPE', 'only JPEG, PNG and WebP are accepted');
  }
  if (!Number.isInteger(input.size) || input.size < 1 || input.size > LOT_RULES.maxPhotoBytes) {
    throw appError('PAYLOAD_TOO_LARGE', 'a photo must be between 1 byte and 10 MB');
  }
  const post = await createPresignedPost(s3, {
    Bucket: config.privateBucket,
    Key: photoKeys(input.lotId, input.photoId).upload,
    Conditions: [
      ['content-length-range', input.size, input.size],
      ['eq', '$Content-Type', input.contentType],
    ],
    Fields: { 'Content-Type': input.contentType },
    Expires: PRESIGN_TTL_SECONDS,
  });
  return {
    url: post.url,
    fields: post.fields,
    photoId: input.photoId,
    expiresInSeconds: PRESIGN_TTL_SECONDS,
  };
};

export const getObjectBuffer = async (
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer | null> => {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) return null;
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (e) {
    if (statusOf(e) === 404 || (e as { name?: string }).name === 'NoSuchKey') return null;
    throw e;
  }
};

export const headObject = async (
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<{ size: number; contentType: string | undefined } | null> => {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: res.ContentLength ?? 0, contentType: res.ContentType };
  } catch (e) {
    if (statusOf(e) === 404 || (e as { name?: string }).name === 'NotFound') return null;
    throw e;
  }
};

export const putObject = async (
  s3: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
};

export const copyObject = async (
  s3: S3Client,
  fromBucket: string,
  toBucket: string,
  key: string,
): Promise<void> => {
  await s3.send(
    new CopyObjectCommand({
      Bucket: toBucket,
      Key: key,
      CopySource: `${fromBucket}/${key}`,
      MetadataDirective: 'COPY',
    }),
  );
};

export const deleteObject = async (s3: S3Client, bucket: string, key: string): Promise<void> => {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
};
