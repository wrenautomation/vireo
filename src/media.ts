/**
 * Media is a bucket: any S3-compatible store (AWS, R2, MinIO). A file goes in under its content
 * hash (`media/<sha32><ext>`, same bytes, same key) and a sample carries `s3://bucket/key`; a page
 * gets a GET URL signed for a day.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

export interface BucketOptions {
  bucket: string;
  /** SDK default (AWS_REGION) when absent. */
  region?: string;
  /** R2, MinIO: their endpoint; path-style follows. */
  endpoint?: string;
  client?: S3Client;
}

export interface Bucket {
  /** Puts bytes, answers `s3://bucket/key`. */
  put(bytes: Uint8Array, ext: string): Promise<string>;
  /** A GET URL for an `s3://` uri of this bucket; any other string comes back as is. */
  url(uri: string, seconds?: number): Promise<string>;
}

/** `s3://bucket/key` → its parts, or null. */
export function parseUri(uri: string): { bucket: string; key: string } | null {
  const m = /^s3:\/\/([^/]+)\/(.+)$/i.exec(uri);
  return m?.[1] && m[2] ? { bucket: m[1], key: m[2] } : null;
}

export const mediaKey = (bytes: Uint8Array, ext: string) =>
  `media/${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}${ext.toLowerCase()}`;

export function s3Bucket(o: BucketOptions): Bucket {
  const client =
    o.client ??
    new S3Client({
      ...(o.region ? { region: o.region } : {}),
      ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : {}),
    });
  return {
    async put(bytes, ext) {
      const key = mediaKey(bytes, ext);
      await client.send(
        new PutObjectCommand({
          Bucket: o.bucket,
          Key: key,
          Body: bytes,
          ContentType: TYPES[ext.toLowerCase()] ?? "application/octet-stream",
        }),
      );
      return `s3://${o.bucket}/${key}`;
    },
    async url(uri, seconds = 86_400) {
      const p = parseUri(uri);
      if (!p || p.bucket !== o.bucket) return uri;
      return getSignedUrl(client, new GetObjectCommand({ Bucket: p.bucket, Key: p.key }), {
        expiresIn: seconds,
      });
    },
  };
}

/** A local file into the bucket; only types a page can show. */
export async function upload(bucket: Bucket, path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (!TYPES[ext])
    throw new Error(`can't show ${path} on a page: one of ${Object.keys(TYPES).join(" ")}`);
  return bucket.put(await readFile(path), ext);
}
