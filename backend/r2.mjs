import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export function createR2Client(config) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export class R2Storage {
  constructor(config, client = createR2Client(config)) {
    this.config = config;
    this.client = client;
  }

  async send(command, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Timeout no R2.')), this.config.timeoutMs);
    try {
      return await this.client.send(command, { abortSignal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  putJson(key, body, immutable, signal) {
    return this.send(new PutObjectCommand({
      Bucket: this.config.bucket, Key: key, Body: body,
      ContentType: 'application/json; charset=utf-8',
      CacheControl: immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, s-maxage=5, must-revalidate',
    }), signal);
  }

  delete(key, signal) {
    return this.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }), signal);
  }

  close() { this.client.destroy?.(); }
}
