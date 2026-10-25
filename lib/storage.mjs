import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

// R2 keeps the last good chunk per round/UF, shared by every server instance and restart.
// Without credentials the cache lives only in memory.
export function createStorage(env = process.env) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  const bucket = env.R2_BUCKET || 'eleicao';
  const prefix = (env.R2_PREFIX || 'presidente').replace(/\/$/, '');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const send = (command) => client.send(command, { abortSignal: AbortSignal.timeout(10000) });
  return {
    async get(key) {
      try {
        const response = await send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}/${key}` }));
        return JSON.parse(await response.Body.transformToString());
      } catch (error) {
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async getBytes(key) {
      try {
        const response = await send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}/${key}` }));
        return await response.Body.transformToByteArray();
      } catch (error) {
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async putBytes(key, bytes, type, cacheControl = 'public, max-age=86400') {
      await send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/${key}`, Body: bytes, ContentType: type, CacheControl: cacheControl }));
    },
    async put(key, value) {
      await send(new PutObjectCommand({
        Bucket: bucket, Key: `${prefix}/${key}`, Body: JSON.stringify(value),
        ContentType: 'application/json; charset=utf-8', CacheControl: 'no-cache',
      }));
    },
  };
}
