/**
 * The storage port. Deliberately tiny: anything richer (signed URLs, lifecycle rules, replication)
 * differs so much between a local directory and a bucket that it belongs to the driver, not here.
 */
export interface StoredObject {
  body: Buffer;
  contentType: string;
  contentLength: number;
}

export interface StorageDriver {
  /** Driver name, for logs and the admin diagnostics panel. */
  readonly name: "local" | "s3";
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject>;
  /**
   * Stream a stored object. Large images should not be buffered through the app just to be handed
   * to a client; `/api/images/[id]` pipes this straight into the response.
   */
  stream(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    contentType: string;
    contentLength: number;
  }>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
