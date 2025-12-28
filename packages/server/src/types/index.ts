/**
 * Durable Streams Types
 *
 * Shared TypeScript type definitions for protocol and storage layers.
 */

export * from "./storage.ts";
export type {
  StreamProtocolInterface,
  StorageFactory,
  StorageStub,
  CreateOptions,
  AppendOptions,
  ReadOptions,
  ReadLiveOptions,
  CreateResult,
  AppendResult,
  MetadataResult,
  DeleteResult,
} from "./protocol.ts";

// Re-export protocol types with different names to avoid conflicts
export type { ReadResult as ProtocolReadResult } from "./protocol.ts";
export type { ReadLiveResult as ProtocolReadLiveResult } from "./protocol.ts";
