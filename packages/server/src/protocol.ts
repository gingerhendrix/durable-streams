/**
 * Protocol Layer Implementation
 *
 * Handles validation, JSON mode processing, cursor generation,
 * and orchestration between HTTP and storage layers.
 */

import type {
  StreamProtocolInterface,
  StorageFactory,
  CreateOptions,
  CreateResult,
  AppendOptions,
  AppendResult,
  ReadOptions,
  ReadLiveOptions,
  MetadataResult,
  DeleteResult,
} from "./types/protocol.ts";
import type { StreamMetadata } from "./types/storage.ts";
import type { ReadResult as ProtocolReadResult } from "./types/protocol.ts";
import type { ReadLiveResult as ProtocolReadLiveResult } from "./types/protocol.ts";

const CURSOR_EPOCH = new Date("2024-10-09T00:00:00.000Z").getTime();
const CURSOR_INTERVAL_MS = 20_000;

export class StreamProtocol implements StreamProtocolInterface {
  constructor(private getStorage: StorageFactory) {}

  async create(
    streamId: string,
    options: CreateOptions
  ): Promise<CreateResult> {
    const storage = this.getStorage(streamId);
    const existing = await storage.getMetadata();

    if (existing) {
      if (!this.configMatches(existing, options)) {
        return { status: "conflict", nextOffset: "", contentType: "" };
      }
      const offset = await storage.getCurrentOffset();
      return {
        status: "exists",
        nextOffset: offset,
        contentType: existing.contentType,
      };
    }

    const contentType = options.contentType ?? "application/octet-stream";

    const nextOffset = await storage.createStream({
      contentType,
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
      initialData: options.initialData
        ? this.processData(options.initialData, contentType)
        : undefined,
    });

    return { status: "created", nextOffset, contentType };
  }

  async append(
    streamId: string,
    options: AppendOptions
  ): Promise<AppendResult> {
    const storage = this.getStorage(streamId);
    const metadata = await storage.getMetadata();

    if (!metadata) {
      return { status: "not-found" };
    }

    if (!this.contentTypeMatches(metadata.contentType, options.contentType)) {
      return { status: "conflict", conflictReason: "content-type" };
    }

    if (options.seq && metadata.lastSeq && options.seq <= metadata.lastSeq) {
      return { status: "conflict", conflictReason: "sequence" };
    }

    const processed = this.processData(options.data, metadata.contentType);

    const nextOffset = await storage.append(processed, options.seq);

    return { status: "ok", nextOffset };
  }

  async read(
    streamId: string,
    options: ReadOptions
  ): Promise<ProtocolReadResult> {
    const storage = this.getStorage(streamId);
    const metadata = await storage.getMetadata();

    if (!metadata) {
      return {
        status: "not-found",
        messages: [],
        nextOffset: "",
        upToDate: false,
      };
    }

    const offset = this.normalizeOffset(options.offset);
    const { messages, nextOffset, upToDate } = await storage.read(offset);

    return { status: "ok", messages, nextOffset, upToDate };
  }

  async readLive(
    streamId: string,
    options: ReadLiveOptions
  ): Promise<ProtocolReadLiveResult> {
    const storage = this.getStorage(streamId);
    const metadata = await storage.getMetadata();

    if (!metadata) {
      return {
        status: "not-found",
        messages: [],
        nextOffset: "",
        upToDate: false,
        cursor: "",
      };
    }

    const { messages, nextOffset, timedOut } = await storage.readLive(
      options.offset,
      options.signal
    );

    return {
      status: timedOut ? "timeout" : "ok",
      messages,
      nextOffset,
      upToDate: true,
      cursor: this.generateCursor(options.cursor),
    };
  }

  async metadata(streamId: string): Promise<MetadataResult> {
    const storage = this.getStorage(streamId);
    const meta = await storage.getMetadata();
    if (!meta) return { status: "not-found" };

    return {
      status: "ok",
      contentType: meta.contentType,
      nextOffset: await storage.getCurrentOffset(),
      ttlSeconds: meta.ttlSeconds,
      expiresAt: meta.expiresAt,
    };
  }

  async delete(streamId: string): Promise<DeleteResult> {
    const storage = this.getStorage(streamId);
    const exists = await storage.getMetadata();
    if (!exists) return { status: "not-found" };

    await storage.deleteAll();
    return { status: "ok" };
  }

  // === Private helpers ===

  private processData(data: Uint8Array, contentType: string): Uint8Array[] {
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return [data];
    }

    const text = new TextDecoder().decode(data);
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return [];  // Return empty array instead of throwing
      }
      // Flatten one level
      return parsed.map((item) =>
        new TextEncoder().encode(JSON.stringify(item))
      );
    }

    return [new TextEncoder().encode(JSON.stringify(parsed))];
  }

  private contentTypeMatches(expected: string, actual: string): boolean {
    const normalize = (ct: string) => ct.toLowerCase().split(";")[0]!.trim();
    return normalize(expected) === normalize(actual);
  }

  private configMatches(
    existing: StreamMetadata,
    options: CreateOptions
  ): boolean {
    const contentType = options.contentType ?? "application/octet-stream";
    if (!this.contentTypeMatches(existing.contentType, contentType)) {
      return false;
    }

    if (existing.ttlSeconds !== options.ttlSeconds) {
      return false;
    }

    if (existing.expiresAt !== options.expiresAt) {
      return false;
    }

    return true;
  }

  private normalizeOffset(offset?: string): string | undefined {
    if (!offset || offset === "-1") return undefined;
    return offset;
  }

  private generateCursor(previous?: string): string {
    const now = Date.now();
    const currentInterval = Math.floor(
      (now - CURSOR_EPOCH) / CURSOR_INTERVAL_MS
    );

    if (!previous) {
      return String(currentInterval);
    }

    const previousInterval = parseInt(previous, 10);
    if (previousInterval < currentInterval) {
      return String(currentInterval);
    }

    // Add jitter: 1-180 intervals (20s each = 1-3600 seconds)
    const jitterIntervals = Math.max(1, Math.floor(Math.random() * 180));
    return String(previousInterval + jitterIntervals);
  }
}
