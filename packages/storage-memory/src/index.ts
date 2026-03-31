/**
 * @durable-streams/storage-memory
 *
 * In-memory storage backend for the Durable Streams protocol.
 * Implements the StreamStorage interface from @durable-streams/core
 * using plain JavaScript data structures.
 *
 * Suitable for development, testing, and ephemeral use cases.
 * Works on any JavaScript runtime (Node, Bun, Deno, browsers).
 */

export { MemoryStreamStorage } from "./storage.ts";

import { MemoryStreamStorage } from "./storage.ts";
import type { StorageFactory } from "@durable-streams/core";

/**
 * Creates a StorageFactory backed by in-memory storage.
 * Each unique streamId gets its own MemoryStreamStorage instance.
 *
 * Usage:
 * ```typescript
 * import { StreamProtocol, HttpHandler } from "@durable-streams/core";
 * import { createMemoryStorageFactory } from "@durable-streams/storage-memory";
 *
 * const storage = createMemoryStorageFactory();
 * const protocol = new StreamProtocol(storage);
 * const handler = new HttpHandler({ protocol });
 * ```
 */
export function createMemoryStorageFactory(): StorageFactory {
  const stores = new Map<string, MemoryStreamStorage>();
  return (streamId: string) => {
    let store = stores.get(streamId);
    if (!store) {
      store = new MemoryStreamStorage();
      stores.set(streamId, store);
    }
    return store;
  };
}

// Re-export core types that users of this package will need
export type {
  StreamStorage,
  StorageFactory,
  StreamMetadata,
  CreateStreamOptions,
  StorageReadResult,
  StorageReadLiveResult,
  StoredMessage,
} from "@durable-streams/core";
