/**
 * Cloudflare Durable Streams
 *
 * Re-export facade that combines @streamsy/core and
 * @streamsy/storage-durable-object for backwards compatibility.
 *
 * New code should import from the individual packages directly:
 *   import { StreamProtocol, HttpHandler } from "@streamsy/core";
 *   import { DurableObjectStreamStorage } from "@streamsy/storage-durable-object";
 */

// Core classes
export { StreamProtocol, HttpHandler } from "@streamsy/core";

// Storage class (re-exported with legacy name for backwards compatibility)
export { DurableObjectStreamStorage as StreamStorage } from "@streamsy/storage-durable-object";

// Type exports from core
export type {
  StreamProtocolInterface,
  StorageFactory,
  CreateOptions,
  CreateResult,
  AppendOptions,
  AppendResult,
  ReadOptions,
  ReadResult,
  ReadLiveOptions,
  ReadLiveResult,
  MetadataResult,
  DeleteResult,
} from "@streamsy/core";

export type {
  StreamStorage as StreamStorageInterface,
  StreamMetadata,
  CreateStreamOptions,
  StorageReadResult,
  StorageReadLiveResult,
  StoredMessage,
} from "@streamsy/core";
