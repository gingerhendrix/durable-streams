---
date: 2025-12-24
project: "[[projects/durable-streams]]"
tags:
  - durable-streams
  - cloudflare-workers
  - architecture
---

# Durable Streams on Cloudflare Workers

Implementation of the Durable Streams protocol on Cloudflare Workers using Durable Objects.

## Documents

- [[http-spec]] - Complete HTTP API reference
- [[types]] - TypeScript type definitions
- [[protocol]] - Protocol layer interface and implementation
- [[storage]] - Storage layer interface

## Design Principles

- **Modular but not a framework** - clean separation of concerns without over-abstraction
- **Single responsibility** - each layer has a clear job
- **One implementation** - not pluggable interfaces everywhere, just good boundaries

## Architecture

Uses **SQLite-backed Durable Objects** with the synchronous KV API (`ctx.storage.kv`).

```
┌─────────────────────────────────────────┐
│              HTTP Layer                  │
│  - Request parsing                       │
│  - Response formatting                   │
│  - Status codes, headers                 │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│           Protocol Layer                 │
│  - Validation                            │
│  - JSON mode processing                  │
│  - Cursor generation                     │
│  - Orchestration (async interface)       │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│            Storage Layer                 │
│  - Persistence (sync KV internally)      │
│  - Offset generation                     │
│  - TTL/alarms                            │
│  - Wait/notify for live reads            │
└─────────────────────────────────────────┘
```

## Layer Responsibilities

### HTTP Layer
- Status code mapping (status strings to 200/201/404/409 etc.)
- Header formatting (Stream-Next-Offset, ETag, Cache-Control)
- Request parsing (headers, query params, body)
- Response body formatting

### Protocol Layer
- Validation (content-type matching, sequence checking, config matching)
- JSON mode processing (array flattening, validation, message boundaries)
- Cursor generation
- Orchestration between HTTP and storage

### Storage Layer
- Persistence (metadata, messages)
- Offset generation
- TTL/expiry via alarms
- Wait/notify for live reads

## Durable Object Structure

The DO class composes protocol and storage. Uses SQLite storage backend.

```typescript
class StreamDO extends DurableObject {
  private storage: StreamStorage
  private protocol: StreamProtocol
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.storage = new DOStreamStorage(ctx)  // uses ctx.storage.kv
    this.protocol = new StreamProtocolImpl(this.storage)
  }
  
  async fetch(request: Request): Promise<Response> {
    // HTTP adapter calls this.protocol methods (all async)
  }
  
  alarm() {
    // TTL cleanup - sync
    this.storage.deleteAll()
  }
}
```
