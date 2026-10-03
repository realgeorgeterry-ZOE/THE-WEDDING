import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from 'npm:@aws-sdk/client-s3@3.1145.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.1145.0';

let cachedClient: S3Client | undefined;

function client() {
  if (cachedClient) return cachedClient;
  const accountId = Deno.env.get('R2_ACCOUNT_ID');
  const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY');
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error('R2 credentials are not configured.');
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

export function r2Bucket(visibility: 'public' | 'private') {
  const bucket = visibility === 'private'
    ? Deno.env.get('R2_BUCKET_NAME')
    : Deno.env.get('R2_PUBLIC_BUCKET_NAME');
  if (!bucket) throw new Error(`R2 ${visibility} bucket is not configured.`);
  return bucket;
}

export async function uploadR2Object(bucket: string, key: string, bytes: Uint8Array, contentType: string, visibility: 'public' | 'private', cacheControl?: string) {
  await client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: bytes,
    ContentType: contentType,
    CacheControl: cacheControl || (visibility === 'private' ? 'private, no-store' : 'public, max-age=300'),
  }));
}

export async function signR2Object(bucket: string, key: string, expiresIn = 60, downloadName?: string) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/["\\\r\n]/g, '_')}"` } : {}),
  });
  return getSignedUrl(client(), command, { expiresIn: Math.max(1, Math.min(expiresIn, 300)) });
}

export async function deleteR2Object(bucket: string, key: string) {
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function testR2Bucket(visibility: 'public' | 'private') {
  const bucket = r2Bucket(visibility);
  const key = `__connectivity_test__/r2-${crypto.randomUUID()}.txt`;
  let uploaded = false;
  let deleted = false;
  try {
    await uploadR2Object(bucket, key, new TextEncoder().encode('R2 connectivity test'), 'text/plain', visibility, 'no-store');
    uploaded = true;
  } catch {
    // Still attempt an idempotent delete in case the request reached R2 before failing.
  }
  try {
    await deleteR2Object(bucket, key);
    deleted = true;
  } catch {
    console.error('r2_connectivity_test_cleanup_failed', { visibility, bucket, key });
  }
  return { bucket_accessible: uploaded, temporary_object_deleted: deleted, success: uploaded && deleted };
}
