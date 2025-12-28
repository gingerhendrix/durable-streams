/**
 * Storage Layer Types
 *
 * Types for the persistence layer that handles offset generation,
 * message storage, and TTL management using Durable Objects.
 */

export interface StoredMessage {
  data: Uint8Array;
  offset: string;
  timestamp: number;
}

export interface StreamMetadata {
  contentType: string;
  ttlSeconds?: number;
  expiresAt?: string;
  createdAt: number;
  lastSeq?: string;
}

export interface CreateStreamOptions {
  contentType: string;
  ttlSeconds?: number;
  expiresAt?: string;
  initialData?: Uint8Array[];
}

export interface ReadResult {
  messages: StoredMessage[];
  nextOffset: string;
  upToDate: boolean;
}

export interface ReadLiveResult {
  messages: StoredMessage[];
  nextOffset: string;
  timedOut: boolean;
}

/**
 * Storage Layer Interface
 *
 * Handles persistence using SQLite-backed Durable Objects with
 * the synchronous KV API (ctx.storage.kv).
 */
export interface StreamStorage {
  // Lifecycle
  createStream(options: CreateStreamOptions): Promise<string>;
  deleteAll(): Promise<void>;

  // Metadata
  getMetadata(): Promise<StreamMetadata | null>;
  getCurrentOffset(): Promise<string>;

  // Messages
  append(messages: Uint8Array[], seq?: string): Promise<string>;
  read(afterOffset?: string): Promise<ReadResult>;

  // Live reads (waits for new messages)
  readLive(afterOffset: string, signal?: AbortSignal): Promise<ReadLiveResult>;
}
