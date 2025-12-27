/**
 * Storage Layer Implementation
 * 
 * SQLite-backed Durable Object storage using the synchronous KV API.
 * Handles persistence, offset generation, and wait/notify for live reads.
 */

import type {
  StreamStorage,
  StreamMetadata,
  CreateStreamOptions,
  ReadResult,
  ReadLiveResult,
  StoredMessage,
} from "cf-durable-streams-types/storage";

export class DOStreamStorage implements StreamStorage {
  private kv: DurableObjectStorage;
  private ctx: DurableObjectState;
  private waiters: Set<() => void> = new Set();

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
    this.kv = ctx.storage;
  }

  async createStream(options: CreateStreamOptions): Promise<string> {
    const metadata: StreamMetadata = {
      contentType: options.contentType,
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
      createdAt: Date.now(),
    };

    await this.kv.put("metadata", metadata);
    await this.kv.put("counter", 0);
    const initialOffset = this.formatOffset(0);
    await this.kv.put("currentOffset", initialOffset);

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

    // Delete all storage
    await this.ctx.storage.deleteAll();
  }

  async getMetadata(): Promise<StreamMetadata | null> {
    return (await this.kv.get<StreamMetadata>("metadata")) ?? null;
  }

  async getCurrentOffset(): Promise<string> {
    return (await this.kv.get<string>("currentOffset")) ?? this.formatOffset(0);
  }

  async append(messages: Uint8Array[], seq?: string): Promise<string> {
    let counter = (await this.kv.get<number>("counter")) ?? 0;
    let lastOffset = "";

    for (const data of messages) {
      counter++;
      const offset = this.formatOffset(counter);
      lastOffset = offset;

      await this.kv.put(`message:${offset}`, {
        data,
        offset,
        timestamp: Date.now(),
      } satisfies StoredMessage);
    }

    await this.kv.put("counter", counter);
    await this.kv.put("currentOffset", lastOffset);

    if (seq) {
      const meta = await this.kv.get<StreamMetadata>("metadata");
      if (meta) {
        await this.kv.put("metadata", { ...meta, lastSeq: seq });
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
      listOptions.start = `message:${afterOffset}`;
      listOptions.startAfter = `message:${afterOffset}`;
    }

    const entries = await this.kv.list<StoredMessage>(listOptions);
    const messages: StoredMessage[] = [];

    for (const [_, value] of entries) {
      messages.push(value);
    }

    const nextOffset =
      messages.length > 0 ? messages[messages.length - 1]!.offset : currentOffset;

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
