/**
 * Cloudflare Durable Streams
 *
 * A Cloudflare Workers implementation of the Durable Streams protocol.
 */

// Core classes
export { StreamProtocol } from "./protocol.ts";
export { StreamStorage } from "./storage.ts";
export { HttpHandler } from "./http.ts";

// Type exports
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
} from "./types/protocol.ts";

export type {
  StreamStorage as StreamStorageInterface,
  StreamMetadata,
  CreateStreamOptions,
  StorageReadResult,
  StorageReadLiveResult,
  StoredMessage,
} from "./types/storage.ts";
