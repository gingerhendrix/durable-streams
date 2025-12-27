/**
 * Durable Streams Server
 *
 * Durable Object implementation of the Durable Streams protocol.
 * Provides HTTP API for append-only stream operations.
 */

import { DurableObject } from "cloudflare:workers";
import { DOStreamStorage } from "./storage.ts";
import { StreamProtocolImpl } from "./protocol.ts";
// Environment type for the worker
interface DurableStreamsServerEnv {
  STREAM_DO: DurableObjectNamespace<StreamDO>;
}

/**
 * Stream Durable Object
 *
 * Each instance manages a single stream with its metadata and messages.
 */
export class StreamDO extends DurableObject {
  private storage: DOStreamStorage;
  private protocol: StreamProtocolImpl;

  constructor(ctx: DurableObjectState, env: DurableStreamsServerEnv) {
    super(ctx, env);
    this.storage = new DOStreamStorage(ctx);
    this.protocol = new StreamProtocolImpl(this.storage);
  }

  /**
   * Handle HTTP requests to the stream
   */
  override async fetch(request: Request): Promise<Response> {
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
  override async alarm(): Promise<void> {
    await this.storage.deleteAll();
  }

  private async handleCreate(request: Request): Promise<Response> {
    const contentType =
      request.headers.get("content-type") ?? "application/octet-stream";
    const ttlHeader = request.headers.get("stream-ttl");
    const expiresAtHeader = request.headers.get("stream-expires-at");

    // Validate TTL format
    if (ttlHeader && !/^(0|[1-9]\d*)$/.test(ttlHeader)) {
      return new Response("Invalid Stream-TTL format", { status: 400 });
    }

    // Cannot specify both TTL and expires-at
    if (ttlHeader && expiresAtHeader) {
      return new Response(
        "Cannot specify both Stream-TTL and Stream-Expires-At",
        {
          status: 400,
        },
      );
    }

    // Validate Expires-At format (must be valid ISO 8601 timestamp)
    if (expiresAtHeader) {
      const parsed = new Date(expiresAtHeader);
      if (isNaN(parsed.getTime())) {
        return new Response("Invalid Stream-Expires-At format", { status: 400 });
      }
    }

    const ttlSeconds = ttlHeader ? parseInt(ttlHeader, 10) : undefined;

    let initialData: ArrayBuffer;
    try {
      initialData = await request.arrayBuffer();
    } catch (error) {
      // Handle payload too large or other body read errors
      console.error("Error reading request body:", error);
      return new Response("Payload too large", { status: 413 });
    }

    let result;
    try {
      result = await this.protocol.create({
        contentType,
        ttlSeconds,
        expiresAt: expiresAtHeader ?? undefined,
        initialData:
          initialData.byteLength > 0 ? new Uint8Array(initialData) : undefined,
      });
    } catch (error) {
      // Handle JSON parsing/validation errors
      if (error instanceof Error && error.message.includes("Empty arrays not allowed")) {
        // For PUT, empty array is valid - it creates an empty stream
        result = await this.protocol.create({
          contentType,
          ttlSeconds,
          expiresAt: expiresAtHeader ?? undefined,
          initialData: undefined,
        });
      } else if (error instanceof SyntaxError) {
        return new Response("Invalid JSON", { status: 400 });
      } else if (error instanceof Error && (
        error.message.includes("value too large") ||
        error.message.includes("Value too large") ||
        error.message.includes("exceeds") ||
        error.message.includes("too big") ||
        error.message.includes("limit")
      )) {
        // Handle storage size limit errors
        console.error("Payload too large for storage:", error);
        return new Response("Payload too large", { status: 413 });
      } else {
        throw error;
      }
    }

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

    let data: ArrayBuffer;
    try {
      data = await request.arrayBuffer();
    } catch (error) {
      // Handle payload too large or other body read errors
      console.error("Error reading request body:", error);
      return new Response("Payload too large", { status: 413 });
    }

    if (data.byteLength === 0) {
      return new Response("Empty body not allowed", { status: 400 });
    }

    let result;
    try {
      result = await this.protocol.append({
        data: new Uint8Array(data),
        contentType,
        seq,
      });
    } catch (error) {
      // Handle JSON parsing/validation errors
      if (error instanceof Error && error.message.includes("Empty arrays not allowed")) {
        return new Response("Empty arrays not allowed", { status: 400 });
      } else if (error instanceof SyntaxError) {
        return new Response("Invalid JSON", { status: 400 });
      } else if (error instanceof Error && (
        error.message.includes("value too large") ||
        error.message.includes("Value too large") ||
        error.message.includes("exceeds") ||
        error.message.includes("too big") ||
        error.message.includes("limit")
      )) {
        // Handle storage size limit errors
        console.error("Payload too large for storage:", error);
        return new Response("Payload too large", { status: 413 });
      } else {
        throw error;
      }
    }

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

    // Generate ETag for cache validation
    const startOffset = offset ?? "-1";
    const etag = `"${btoa(url.pathname)}:${startOffset}:${result.nextOffset}"`;

    // Check If-None-Match header for conditional request
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          etag,
          "cache-control": "public, max-age=60, stale-while-revalidate=300",
        },
      });
    }

    // For JSON streams, format as array
    const metadata = await this.storage.getMetadata();
    const contentTypeLower = metadata?.contentType.toLowerCase() ?? "";
    const isJson = contentTypeLower.startsWith("application/json");
    const isText = contentTypeLower.startsWith("text/");

    let body: string | Uint8Array;
    if (isJson) {
      // JSON streams always return an array (even if empty)
      const items = result.messages.map((msg) =>
        new TextDecoder().decode(msg.data),
      );
      body = `[${items.join(",")}]`;
    } else if (isText) {
      body = result.messages
        .map((msg) => new TextDecoder().decode(msg.data))
        .join("");
    } else {
      // Binary content - concatenate raw bytes without text decoding
      const totalLength = result.messages.reduce((acc, msg) => acc + msg.data.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const msg of result.messages) {
        combined.set(msg.data, offset);
        offset += msg.data.length;
      }
      body = combined;
    }

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

  private async handleLongPoll(
    offset: string,
    cursor?: string,
  ): Promise<Response> {
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
    const contentTypeLower = metadata?.contentType.toLowerCase() ?? "";
    const isJson = contentTypeLower.startsWith("application/json");
    const isText = contentTypeLower.startsWith("text/");

    let body: string | Uint8Array;
    if (isJson && result.messages.length > 0) {
      const items = result.messages.map((msg) =>
        new TextDecoder().decode(msg.data),
      );
      body = `[${items.join(",")}]`;
    } else if (isText) {
      body = result.messages
        .map((msg) => new TextDecoder().decode(msg.data))
        .join("");
    } else {
      // Binary content - concatenate raw bytes without text decoding
      const totalLength = result.messages.reduce((acc, msg) => acc + msg.data.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const msg of result.messages) {
        combined.set(msg.data, offset);
        offset += msg.data.length;
      }
      body = combined;
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
    // Get metadata to validate content type
    const metadata = await this.storage.getMetadata();

    if (!metadata) {
      return new Response("Stream not found", { status: 404 });
    }

    // SSE only valid for text/* or application/json
    const contentTypeLower = metadata.contentType.toLowerCase();
    const isText = contentTypeLower.startsWith("text/");
    const isJson = contentTypeLower.startsWith("application/json");

    if (!isText && !isJson) {
      return new Response(
        "SSE mode requires text/* or application/json content type",
        { status: 400 },
      );
    }

    // Create a readable stream for SSE
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let currentOffset = offset;
    let currentCursor = cursor;
    const connectionStartTime = Date.now();
    const CONNECTION_TIMEOUT_MS = 60_000; // Close after ~60s for CDN collapsing

    // Helper to generate cursor
    const generateCursor = (previous?: string): string => {
      const CURSOR_EPOCH = new Date("2024-10-09T00:00:00.000Z").getTime();
      const CURSOR_INTERVAL_MS = 20_000;
      const now = Date.now();
      const currentInterval = Math.floor((now - CURSOR_EPOCH) / CURSOR_INTERVAL_MS);

      if (!previous) {
        return String(currentInterval);
      }

      const previousInterval = parseInt(previous, 10);
      if (previousInterval < currentInterval) {
        return String(currentInterval);
      }

      const jitterIntervals = Math.max(1, Math.floor(Math.random() * 180));
      return String(previousInterval + jitterIntervals);
    };

    const stream = new ReadableStream({
      start: async (controller) => {
        try {
          // First, do a non-blocking read to get current state and send initial control event
          // This ensures clients immediately know the connection is established
          const initialResult = await this.protocol.read({
            offset: currentOffset === "-1" ? undefined : currentOffset,
          });

          if (initialResult.status === "not-found") {
            controller.close();
            return;
          }

          // Send data events if we have messages from initial read
          if (initialResult.messages.length > 0) {
            if (isJson) {
              const items = initialResult.messages.map((msg) =>
                decoder.decode(msg.data),
              );
              controller.enqueue(encoder.encode("event: data\n"));
              controller.enqueue(encoder.encode("data: [\n"));
              for (let i = 0; i < items.length; i++) {
                const suffix = i < items.length - 1 ? "," : "";
                controller.enqueue(
                  encoder.encode(`data: ${items[i]}${suffix}\n`),
                );
              }
              controller.enqueue(encoder.encode("data: ]\n"));
              controller.enqueue(encoder.encode("\n"));
            } else {
              const text = initialResult.messages
                .map((msg) => decoder.decode(msg.data))
                .join("");
              const lines = text.split("\n");
              controller.enqueue(encoder.encode("event: data\n"));
              for (const line of lines) {
                controller.enqueue(encoder.encode(`data: ${line}\n`));
              }
              controller.enqueue(encoder.encode("\n"));
            }
          }

          // Send initial control event immediately (even for empty streams)
          currentCursor = generateCursor(currentCursor);
          const initialControlData: {
            streamNextOffset: string;
            streamCursor: string;
            upToDate?: boolean;
          } = {
            streamNextOffset: initialResult.nextOffset,
            streamCursor: currentCursor,
          };
          if (initialResult.upToDate) {
            initialControlData.upToDate = true;
          }
          controller.enqueue(encoder.encode("event: control\n"));
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(initialControlData)}\n`),
          );
          controller.enqueue(encoder.encode("\n"));

          // Update offset for live polling
          currentOffset = initialResult.nextOffset;

          // Now enter the live polling loop
          while (true) {
            // Check if we should close connection for CDN collapsing
            if (Date.now() - connectionStartTime >= CONNECTION_TIMEOUT_MS) {
              controller.close();
              return;
            }

            // Read messages using protocol layer (blocking)
            const result = await this.protocol.readLive({
              offset: currentOffset,
              mode: "sse",
              cursor: currentCursor,
            });

            if (result.status === "not-found") {
              controller.close();
              return;
            }

            // Send data events if we have messages
            if (result.messages.length > 0) {
              if (isJson) {
                // For JSON, batch messages as array
                const items = result.messages.map((msg) =>
                  decoder.decode(msg.data),
                );
                controller.enqueue(encoder.encode("event: data\n"));
                controller.enqueue(encoder.encode("data: [\n"));
                for (let i = 0; i < items.length; i++) {
                  const suffix = i < items.length - 1 ? "," : "";
                  controller.enqueue(
                    encoder.encode(`data: ${items[i]}${suffix}\n`),
                  );
                }
                controller.enqueue(encoder.encode("data: ]\n"));
                controller.enqueue(encoder.encode("\n"));
              } else {
                // For text, send each line
                const text = result.messages
                  .map((msg) => decoder.decode(msg.data))
                  .join("");
                const lines = text.split("\n");
                controller.enqueue(encoder.encode("event: data\n"));
                for (const line of lines) {
                  controller.enqueue(encoder.encode(`data: ${line}\n`));
                }
                controller.enqueue(encoder.encode("\n"));
              }
            }

            // Send control event
            const controlData: {
              streamNextOffset: string;
              streamCursor: string;
              upToDate?: boolean;
            } = {
              streamNextOffset: result.nextOffset,
              streamCursor: result.cursor,
            };
            if (result.upToDate) {
              controlData.upToDate = true;
            }
            controller.enqueue(encoder.encode("event: control\n"));
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(controlData)}\n`),
            );
            controller.enqueue(encoder.encode("\n"));

            // Update state for next iteration
            currentOffset = result.nextOffset;
            currentCursor = result.cursor;

            // If timed out waiting for messages, continue loop for keep-alive
            // The readLive handles waiting, so we just loop
            if (result.status === "timeout") {
              // Keep-alive sent via control event above
              continue;
            }
          }
        } catch (error) {
          console.error("SSE stream error:", error);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
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
        ...(result.ttlSeconds
          ? { "stream-ttl": String(result.ttlSeconds) }
          : {}),
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
  async fetch(
    request: Request,
    env: DurableStreamsServerEnv,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Extract stream path - everything after /streams/
    const streamPath = url.pathname.replace(/^\/streams\//, "");

    if (!streamPath || streamPath === url.pathname) {
      return new Response("Stream path required: /streams/{path}", {
        status: 400,
      });
    }

    // Get or create Durable Object instance for this stream
    const id = env.STREAM_DO.idFromName(streamPath);
    const stub = env.STREAM_DO.get(id);

    // Forward request to the DO
    return stub.fetch(request);
  },
} satisfies ExportedHandler<DurableStreamsServerEnv>;
