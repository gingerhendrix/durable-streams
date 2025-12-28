/**
 * Storage Layer Implementation
 *
 * SQLite-backed Durable Object storage.
 * Extends DurableObject for RPC access from the protocol layer.
 * Uses the async storage API for compatibility.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  StreamStorage as StreamStorageInterface,
  StreamMetadata,
  CreateStreamOptions,
  ReadResult,
  ReadLiveResult,
  StoredMessage,
} from "./types/storage.ts";

// Empty env type since StreamStorage doesn't use env bindings
type StreamStorageEnv = Record<string, never>;

export class StreamStorage
  extends DurableObject<StreamStorageEnv>
  implements StreamStorageInterface
{
  private waiters: Set<() => void> = new Set();
  private metadata: StreamMetadata | null = null;
  private metadataLoaded = false;

  constructor(ctx: DurableObjectState, env: StreamStorageEnv) {
    super(ctx, env);
    // Load metadata synchronously in constructor for memoization
    this.loadMetadata();
  }

  private loadMetadata(): void {
    // Use synchronous KV API if available, otherwise defer to first access
    try {
      const kv = (this.ctx.storage as any).kv;
      if (kv) {
        this.metadata = kv.get("metadata") ?? null;
        this.metadataLoaded = true;
      }
    } catch {
      // Fall back to async load on first access
    }
  }

  /**
   * TTL alarm handler - deletes expired streams
   */
  override async alarm(): Promise<void> {
    await this.deleteAll();
  }

  async createStream(options: CreateStreamOptions): Promise<string> {
    const metadata: StreamMetadata = {
      contentType: options.contentType,
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
      createdAt: Date.now(),
    };

    await this.ctx.storage.put("metadata", metadata);
    await this.ctx.storage.put("counter", 0);
    const initialOffset = this.formatOffset(0);
    await this.ctx.storage.put("currentOffset", initialOffset);

    // Update memoized metadata
    this.metadata = metadata;
    this.metadataLoaded = true;

    // Set alarm for TTL if configured
    if (options.ttlSeconds) {
      await this.ctx.storage.setAlarm(Date.now() + options.ttlSeconds * 1000);
    } else if (options.expiresAt) {
      await this.ctx.storage.setAlarm(new Date(options.expiresAt).getTime());
    }

    // Handle initial data
    if (options.initialData?.length) {
      return await this.append(options.initialData);
    }

    return initialOffset;
  }

  async deleteAll(): Promise<void> {
    // Clear all waiters
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters.clear();

    // Clear memoized metadata
    this.metadata = null;

    // Delete all storage
    await this.ctx.storage.deleteAll();
  }

  async getMetadata(): Promise<StreamMetadata | null> {
    // Return memoized metadata if already loaded
    if (this.metadataLoaded) {
      return this.metadata;
    }

    // Load from storage
    this.metadata =
      (await this.ctx.storage.get<StreamMetadata>("metadata")) ?? null;
    this.metadataLoaded = true;
    return this.metadata;
  }

  async getCurrentOffset(): Promise<string> {
    return (
      (await this.ctx.storage.get<string>("currentOffset")) ??
      this.formatOffset(0)
    );
  }

  async append(messages: Uint8Array[], seq?: string): Promise<string> {
    let counter = (await this.ctx.storage.get<number>("counter")) ?? 0;
    let lastOffset = "";

    for (const data of messages) {
      counter++;
      const offset = this.formatOffset(counter);
      lastOffset = offset;

      await this.ctx.storage.put(`message:${offset}`, {
        data,
        offset,
        timestamp: Date.now(),
      } satisfies StoredMessage);
    }

    await this.ctx.storage.put("counter", counter);
    await this.ctx.storage.put("currentOffset", lastOffset);

    if (seq) {
      const meta = await this.ctx.storage.get<StreamMetadata>("metadata");
      if (meta) {
        const updatedMeta = { ...meta, lastSeq: seq };
        await this.ctx.storage.put("metadata", updatedMeta);
        this.metadata = updatedMeta;
      }
    }

    // Notify waiters
    this.notifyWaiters();

    return lastOffset;
  }

  async read(afterOffset?: string): Promise<ReadResult> {
    const currentOffset = await this.getCurrentOffset();

    const listOptions: DurableObjectListOptions = {
      prefix: "message:",
    };

    if (afterOffset) {
      listOptions.startAfter = `message:${afterOffset}`;
    }

    const entries = await this.ctx.storage.list<StoredMessage>(listOptions);
    const messages: StoredMessage[] = [];

    for (const [_, value] of entries) {
      messages.push(value);
    }

    const nextOffset =
      messages.length > 0
        ? messages[messages.length - 1]!.offset
        : currentOffset;

    return {
      messages,
      nextOffset,
      upToDate: nextOffset === currentOffset,
    };
  }

  async readLive(
    afterOffset: string,
    signal?: AbortSignal
  ): Promise<ReadLiveResult> {
    // Check for existing messages
    const result = await this.read(afterOffset);
    if (result.messages.length > 0) {
      return { ...result, timedOut: false };
    }

    // Wait for new messages or timeout
    const timeout = 30_000;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.waiters.delete(notify);
        resolve({
          messages: [],
          nextOffset: result.nextOffset,
          timedOut: true,
        });
      }, timeout);

      const notify = async () => {
        clearTimeout(timeoutId);
        this.waiters.delete(notify);
        const r = await this.read(afterOffset);
        resolve({ ...r, timedOut: false });
      };

      this.waiters.add(notify);

      signal?.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        this.waiters.delete(notify);
        resolve({
          messages: [],
          nextOffset: result.nextOffset,
          timedOut: true,
        });
      });
    });
  }

  private notifyWaiters() {
    for (const waiter of this.waiters) {
      waiter();
    }
  }

  private formatOffset(counter: number): string {
    const counterStr = String(counter).padStart(16, "0");
    const byteOffset = "0".repeat(16);
    return `${counterStr}_${byteOffset}`;
  }
}
