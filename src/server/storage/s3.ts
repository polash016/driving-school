import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { schoolConfig } from "../../../config/school.config";
import type { StorageDriver, StoredObject } from "./types";

/**
 * S3-compatible object storage — AWS, Hetzner, Backblaze B2, MinIO.
 *
 * The bucket must be PRIVATE. Nothing here ever mints a public URL: images reach a student only
 * through `/api/images/[id]`, which checks the session first. `forcePathStyle` is on because every
 * S3-compatible store other than AWS itself needs it.
 *
 * Credentials come from the environment, never from `school.config.ts` — that file is committed.
 */
function client(): S3Client {
  const { region, endpoint } = schoolConfig.storage;
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "storage.driver is 's3' but STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY are not set.",
    );
  }
  return new S3Client({
    region: region ?? "us-east-1",
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId, secretAccessKey },
  });
}

function bucket(): string {
  const name = schoolConfig.storage.bucket;
  if (!name)
    throw new Error(
      "storage.driver is 's3' but storage.bucket is not configured.",
    );
  return name;
}

export function s3Driver(): StorageDriver {
  let s3: S3Client | null = null;
  const connection = () => (s3 ??= client());

  return {
    name: "s3",

    async put(key, body, contentType) {
      await connection().send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },

    async get(key): Promise<StoredObject> {
      const result = await connection().send(
        new GetObjectCommand({ Bucket: bucket(), Key: key }),
      );
      const body = Buffer.from(await result.Body!.transformToByteArray());
      return {
        body,
        contentType: result.ContentType ?? "application/octet-stream",
        contentLength: body.byteLength,
      };
    },

    async stream(key) {
      const result = await connection().send(
        new GetObjectCommand({ Bucket: bucket(), Key: key }),
      );
      return {
        body: result.Body!.transformToWebStream() as ReadableStream<Uint8Array>,
        contentType: result.ContentType ?? "application/octet-stream",
        contentLength: result.ContentLength ?? 0,
      };
    },

    async delete(key) {
      await connection().send(
        new DeleteObjectCommand({ Bucket: bucket(), Key: key }),
      );
    },

    async exists(key) {
      try {
        await connection().send(
          new HeadObjectCommand({ Bucket: bucket(), Key: key }),
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
