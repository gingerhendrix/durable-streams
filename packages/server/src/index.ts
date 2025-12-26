/**
 * Durable Streams Server
 * 
 * Durable Object implementation of the Durable Streams protocol.
 * Provides HTTP API for append-only stream operations.
 */

import { DurableObject } from "cloudflare:workers";
import { DOStreamStorage } from "./storage.ts";
import { StreamProtocolImpl } from "./protocol.ts";
import type { DurableStreamsServerEnv } from "../alchemy.resource.ts";

/**
 * Stream Durable Object
 * 
 * Each instance manages a single stream with its metadata and messages.
 */
export class StreamDO extends DurableObject {
  private storage: DOStreamStorage;
  private protocol: StreamProtocolImpl;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.storage = new DOStreamStorage(ctx);
    this.protocol = new StreamProtocolImpl(this.storage);
  }

  /**
   * Handle HTTP requests to the stream
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    try {
      // Handle different HTTP methods
      switch (method) {
        case "PUT":
          return await this.handleCreate(request);
        case "POST":
          return await this.handleAppend(request);
        case "GET":
          return await this.handleRead(request, url);
        case "HEAD":
          return await this.handleMetadata();
        case "DELETE":
          return await this.handleDelete();
        default:
          return new Response("Method not allowed", { status: 405 });
      }
    } catch (error) {
      console.error("Error handling request:", error);
      return new Response("Internal server error", { status: 500 });
    }
  }

  /**
   * TTL alarm handler - deletes expired streams
   */
  async alarm(): Promise<void> {
    await this.storage.deleteAll();
  }

  private async handleCreate(request: Request): Promise<Response> {
    const contentType = request.headers.get("content-type") ?? "application/octet-stream";
    const ttlHeader = request.headers.get("stream-ttl");
    const expiresAtHeader = request.headers.get("stream-expires-at");

    // Validate TTL format
    if (ttlHeader && !/^(0|[1-9]\d*)$/.test(ttlHeader)) {
      return new Response("Invalid Stream-TTL format", { status: 400 });
    }

    // Cannot specify both TTL and expires-at
    if (ttlHeader && expiresAtHeader) {
      return new Response("Cannot specify both Stream-TTL and Stream-Expires-At", {
        status: 400,
      });
    }

    const ttlSeconds = ttlHeader ? parseInt(ttlHeader, 10) : undefined;
    const initialData = await request.arrayBuffer();

    const result = await this.protocol.create({
      contentType,
      ttlSeconds,
      expiresAt: expiresAtHeader ?? undefined,
      initialData: initialData.byteLength > 0 ? new Uint8Array(initialData) : undefined,
    });

    if (result.status === "conflict") {
      return new Response("Stream exists with different configuration", {
        status: 409,
      });
    }

    const status = result.status === "created" ? 201 : 200;
    return new Response(null, {
      status,
      headers: {
        "content-type": result.contentType,
        "stream-next-offset": result.nextOffset,
        ...(status === 201 ? { location: request.url } : {}),
      },
    });
  }

  private async handleAppend(request: Request): Promise<Response> {
    const contentType = request.headers.get("content-type");
    if (!contentType) {
      return new Response("Content-Type required", { status: 400 });
    }

    const seq = request.headers.get("stream-seq") ?? undefined;
    const data = await request.arrayBuffer();

    if (data.byteLength === 0) {
      return new Response("Empty body not allowed", { status: 400 });
    }

    const result = await this.protocol.append({
      data: new Uint8Array(data),
      contentType,
      seq,
    });

    if (result.status === "not-found") {
      return new Response("Stream not found", { status: 404 });
    }

    if (result.status === "conflict") {
      const message =
        result.conflictReason === "content-type"
          ? "Content-Type mismatch"
          : "Sequence conflict";
      return new Response(message, { status: 409 });
    }

    return new Response(null, {
      status: 204,
      headers: {
        "stream-next-offset": result.nextOffset!,
      },
    });
  }

  private async handleRead(request: Request, url: URL): Promise<Response> {
    const offset = url.searchParams.get("offset") ?? undefined;
    const live = url.searchParams.get("live");
    const cursor = url.searchParams.get("cursor") ?? undefined;

    // Validate offset format
    if (offset !== undefined && offset !== "-1" && !/^\d+_\d+$/.test(offset)) {
      return new Response("Invalid offset format", { status: 400 });
    }

    // Handle live modes
    if (live === "long-poll" || live === "sse") {
      if (!offset) {
        return new Response("offset required for live modes", { status: 400 });
      }

      if (live === "sse") {
        return await this.handleSSE(offset, cursor);
      }

      return await this.handleLongPoll(offset, cursor);
    }

    // Regular catch-up read
    const result = await this.protocol.read({ offset });

    if (result.status === "not-found") {
      return new Response("Stream not found", { status: 404 });
    }

    // For JSON streams, format as array
    const metadata = await this.storage.getMetadata();
    const isJson = metadata?.contentType.toLowerCase().startsWith("application/json");

    let body: string;
    if (isJson && result.messages.length > 0) {
      const items = result.messages.map((msg) => new TextDecoder().decode(msg.data));
      body = `[${items.join(",")}]`;
    } else {
      body = result.messages.map((msg) => new TextDecoder().decode(msg.data)).join("");
    }

    const startOffset = offset ?? "-1";
    const etag = `"${btoa(url.pathname)}:${startOffset}:${result.nextOffset}"`;

    return new Response(body, {
      headers: {
        "content-type": metadata!.contentType,
        "stream-next-offset": result.nextOffset,
        ...(result.upToDate ? { "stream-up-to-date": "true" } : {}),
        etag,
        "cache-control": "public, max-age=60, stale-while-revalidate=300",
      },
    });
  }

  private async handleLongPoll(offset: string, cursor?: string): Promise<Response> {
    const result = await this.protocol.readLive({
      offset,
      mode: "long-poll",
      cursor,
    });

    if (result.status === "not-found") {
      return new Response("Stream not found", { status: 404 });
    }

    if (result.status === "timeout" || result.messages.length === 0) {
      return new Response(null, {
        status: 204,
        headers: {
          "stream-next-offset": result.nextOffset,
          "stream-up-to-date": "true",
          "stream-cursor": result.cursor,
        },
      });
    }

    const metadata = await this.storage.getMetadata();
    const isJson = metadata?.contentType.toLowerCase().startsWith("application/json");

    let body: string;
    if (isJson && result.messages.length > 0) {
      const items = result.messages.map((msg) => new TextDecoder().decode(msg.data));
      body = `[${items.join(",")}]`;
    } else {
      body = result.messages.map((msg) => new TextDecoder().decode(msg.data)).join("");
    }

    return new Response(body, {
      headers: {
        "content-type": metadata!.contentType,
        "stream-next-offset": result.nextOffset,
        "stream-up-to-date": "true",
        "stream-cursor": result.cursor,
      },
    });
  }

  private async handleSSE(offset: string, cursor?: string): Promise<Response> {
    // SSE implementation would go here
    // This is a placeholder for the full SSE implementation
    return new Response("SSE mode not yet implemented", { status: 501 });
  }

  private async handleMetadata(): Promise<Response> {
    const result = await this.protocol.metadata();

    if (result.status === "not-found") {
      return new Response("Stream not found", { status: 404 });
    }

    return new Response(null, {
      headers: {
        "content-type": result.contentType!,
        "stream-next-offset": result.nextOffset!,
        ...(result.ttlSeconds ? { "stream-ttl": String(result.ttlSeconds) } : {}),
        ...(result.expiresAt ? { "stream-expires-at": result.expiresAt } : {}),
        "cache-control": "no-store",
      },
    });
  }

  private async handleDelete(): Promise<Response> {
    const result = await this.protocol.delete();

    if (result.status === "not-found") {
      return new Response("Stream not found", { status: 404 });
    }

    return new Response(null, { status: 204 });
  }
}

/**
 * Worker entry point
 * 
 * Routes requests to the appropriate Durable Object instance.
 */
export default {
  async fetch(request: Request, env: DurableStreamsServerEnv): Promise<Response> {
    const url = new URL(request.url);
    
    // Extract stream path - everything after /streams/
    const streamPath = url.pathname.replace(/^\/streams\//, "");
    
    if (!streamPath || streamPath === url.pathname) {
      return new Response("Stream path required: /streams/{path}", { status: 400 });
    }

    // Get or create Durable Object instance for this stream
    const id = env.STREAM_DO.idFromName(streamPath);
    const stub = env.STREAM_DO.get(id);

    // Forward request to the DO
    return stub.fetch(request);
  },
} satisfies ExportedHandler<DurableStreamsServerEnv>;
