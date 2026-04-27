/**
 * @streamsy/storage-durable-object
 *
 * Cloudflare Durable Object storage backend for the Durable Streams protocol.
 * Implements the StreamStorage interface from @streamsy/core using
 * Durable Object synchronous KV storage.
 */

export { DurableObjectStreamStorage } from "./storage.ts";

// Re-export core types that users of this package will need
export type {
  StreamStorage,
  StreamMetadata,
  CreateStreamOptions,
  StorageReadResult,
  StorageReadLiveResult,
  StoredMessage,
} from "@streamsy/core";
