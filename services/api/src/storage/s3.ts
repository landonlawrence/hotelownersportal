import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { contentDisposition, type ObjectStorage, type PresignedUpload } from './types.js';

export class S3Storage implements ObjectStorage {
  constructor(private readonly s3 = new S3Client({})) {}

  async presignUpload(bucket: string, key: string, contentType: string, maxBytes: number, ttlSeconds: number): Promise<PresignedUpload> {
    const post = await createPresignedPost(this.s3, {
      Bucket: bucket,
      Key: key,
      Expires: ttlSeconds,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        ['eq', '$Content-Type', contentType],
        ['eq', '$key', key],
      ],
      Fields: { 'Content-Type': contentType, 'x-amz-server-side-encryption': 'aws:kms' },
    });
    return { url: post.url, fields: post.fields, method: 'POST', expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }

  async presignDownload(bucket: string, key: string, opts: { filename: string; contentType: string; ttlSeconds: number }) {
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(opts.filename),
        ResponseContentType: opts.contentType,
      }),
      { expiresIn: opts.ttlSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + opts.ttlSeconds * 1000).toISOString() };
  }

  async head(bucket: string, key: string) {
    try {
      const out = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: out.ContentLength ?? 0, contentType: out.ContentType };
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound') return null;
      throw e;
    }
  }

  async get(bucket: string, key: string): Promise<Uint8Array> {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return out.Body!.transformToByteArray();
  }

  async put(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'aws:kms' }));
  }

  async move(bucket: string, fromKey: string, toKey: string): Promise<void> {
    await this.s3.send(new CopyObjectCommand({ Bucket: bucket, Key: toKey, CopySource: `${bucket}/${encodeURIComponent(fromKey)}`, ServerSideEncryption: 'aws:kms' }));
    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
  }
}
