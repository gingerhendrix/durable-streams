/**
 * Cloudflare Durable Streams
 *
 * Re-export facade that combines @durable-streams/core and
 * @durable-streams/storage-durable-object for backwards compatibility.
 *
 * New code should import from the individual packages directly:
 *   import { StreamProtocol, HttpHandler } from "@durable-streams/core";
 *   import { DurableObjectStreamStorage } from "@durable-streams/storage-durable-object";
 */

// Core classes
export { StreamProtocol, HttpHandler } from "@durable-streams/core";

// Storage class (re-exported with legacy name for backwards compatibility)
export { DurableObjectStreamStorage as StreamStorage } from "@durable-streams/storage-durable-object";

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
} from "@durable-streams/core";

export type {
  StreamStorage as StreamStorageInterface,
  StreamMetadata,
  CreateStreamOptions,
  StorageReadResult,
  StorageReadLiveResult,
  StoredMessage,
} from "@durable-streams/core";
