---
date: 2025-12-27
project: "[[projects/durable-streams]]"
tags:
  - durable-streams
  - refactoring
  - factory-pattern
---

# Durable Streams Factory Pattern Refactoring

Complete the factory pattern refactoring and cleanup tasks.

## Goals

1. Complete factory pattern refactoring (protocol receives factory, methods take streamId)
2. Rename `StreamProtocolImpl` → `StreamProtocol`
3. Import env types from `alchemy.run.ts`
4. Move types package into server package

## Current Architecture

```
HttpHandler(storageFactory)
  └─ per request: creates StreamProtocolImpl(storage stub)
     └─ StreamProtocolImpl methods: create(), append(), read(), etc
```

## Target Architecture

```
index.ts (composition root):
  ├─ storageFactory = (streamId) => env.STREAM_DO.get(id)
  ├─ protocol = new StreamProtocol(storageFactory)
  └─ handler = new HttpHandler(protocol)
     └─ handler extracts streamId, calls protocol.create(streamId, ...)
```

## Tasks

### Task 1: Rename StreamProtocolImpl → StreamProtocol

**File**: `packages/server/src/protocol.ts`

1. Rename class `StreamProtocolImpl` to `StreamProtocol`
2. Update all imports in `packages/server/src/http.ts`

### Task 2: Refactor Protocol to Use Factory

**File**: `packages/server/src/protocol.ts`

1. Change constructor signature:
```typescript
type StorageFactory = (streamId: string) => DurableObjectStub<StreamStorage>;

export class StreamProtocol implements StreamProtocol {
  constructor(private getStorage: StorageFactory) {}
```

2. Update all protocol methods to take `streamId` as first parameter:
```typescript
async create(streamId: string, options: CreateOptions): Promise<CreateResult> {
  const storage = this.getStorage(streamId);
  // ... rest of implementation
}

async append(streamId: string, options: AppendOptions): Promise<AppendResult> {
  const storage = this.getStorage(streamId);
  // ... rest of implementation
}

async read(streamId: string, options: ReadOptions): Promise<ReadResult> {
  const storage = this.getStorage(streamId);
  // ... rest of implementation
}

async readLive(streamId: string, options: ReadLiveOptions): Promise<ReadLiveResult> {
  const storage = this.getStorage(streamId);
  // ... rest of implementation
}

async metadata(streamId: string): Promise<MetadataResult> {
  const storage = this.getStorage(streamId);
  // ... rest of implementation
}

async delete(streamId: string): Promise<DeleteResult> {
  const storage = this.getStorage(streamId);
  // ... rest of implementation
}
```

### Task 3: Update Protocol Interface

**File**: `packages/types/src/protocol.ts` (will move later)

Update interface to match:
```typescript
export interface StreamProtocol {
  create(streamId: string, options: CreateOptions): Promise<CreateResult>;
  append(streamId: string, options: AppendOptions): Promise<AppendResult>;
  read(streamId: string, options: ReadOptions): Promise<ReadResult>;
  readLive(streamId: string, options: ReadLiveOptions): Promise<ReadLiveResult>;
  metadata(streamId: string): Promise<MetadataResult>;
  delete(streamId: string): Promise<DeleteResult>;
}
```

### Task 4: Refactor HttpHandler

**File**: `packages/server/src/http.ts`

1. Change constructor to receive protocol:
```typescript
export class HttpHandler {
  constructor(private protocol: StreamProtocol) {}
```

2. Update all handler methods to extract streamId and pass to protocol:
```typescript
private async handleCreate(
  request: Request,
  streamId: string  // Add this parameter
): Promise<Response> {
  // ... validation logic
  
  const result = await this.protocol.create(streamId, {
    contentType,
    ttlSeconds,
    expiresAt: expiresAtHeader ?? undefined,
    initialData: initialData.byteLength > 0 ? new Uint8Array(initialData) : undefined,
  });
  
  // ... response logic
}
```

3. Update fetch method to extract streamId once and pass to handlers:
```typescript
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const streamPath = url.pathname.replace(/^\/streams\//, "");
  
  if (!streamPath || streamPath === url.pathname) {
    return new Response("Stream path required: /streams/{path}", { status: 400 });
  }

  const method = request.method;

  try {
    switch (method) {
      case "PUT":
        return await this.handleCreate(request, streamPath);
      case "POST":
        return await this.handleAppend(request, streamPath);
      case "GET":
        return await this.handleRead(request, url, streamPath);
      case "HEAD":
        return await this.handleMetadata(streamPath);
      case "DELETE":
        return await this.handleDelete(streamPath);
      default:
        return new Response("Method not allowed", { status: 405 });
    }
  } catch (error) {
    console.error("Error handling request:", error);
    return new Response("Internal server error", { status: 500 });
  }
}
```

4. Remove storage parameter from all handler methods
5. Update all handler methods to use `this.protocol` with streamId

### Task 5: Update Index Composition Root

**File**: `packages/server/src/index.ts`

1. Import env type from alchemy:
```typescript
import type { DurableStreamsServerEnv } from "../alchemy.run.ts";
```

2. Remove local env interface definition

3. Update fetch handler:
```typescript
export default {
  async fetch(
    request: Request,
    env: DurableStreamsServerEnv
  ): Promise<Response> {
    // Create storage factory from env binding
    const storageFactory = (streamId: string) => {
      const id = env.STREAM_DO.idFromName(streamId);
      return env.STREAM_DO.get(id);
    };

    // Create protocol with factory
    const protocol = new StreamProtocol(storageFactory);

    // Create handler with protocol
    const handler = new HttpHandler(protocol);

    // Execute request
    return handler.fetch(request);
  },
} satisfies ExportedHandler<DurableStreamsServerEnv>;
```

### Task 6: Move Types Package into Server

1. Create directory: `packages/server/src/types/`

2. Move files:
   - `packages/types/src/storage.ts` → `packages/server/src/types/storage.ts`
   - `packages/types/src/protocol.ts` → `packages/server/src/types/protocol.ts`
   - `packages/types/src/index.ts` → `packages/server/src/types/index.ts`

3. Update all imports throughout the codebase:
   - `"cf-durable-streams-types/storage"` → `"./types/storage.ts"` (or relative path)
   - `"cf-durable-streams-types/protocol"` → `"./types/protocol.ts"`
   - `"cf-durable-streams-types"` → `"./types/index.ts"`

4. Remove `packages/types/` directory entirely

5. Update `packages/server/package.json` if it has dependencies on types package

6. Update root `package.json` workspaces if needed

### Task 7: Update Storage Env Interface

**File**: `packages/server/src/storage.ts`

Currently has:
```typescript
interface StreamStorageEnv {
  // Env bindings if needed
}
```

This can likely be removed or updated to use proper env type if needed.

## Testing

After each major change:
1. Run typecheck: `cd packages/server && bun run typecheck`
2. Run tests: `SERVER_BASE_URL=http://localhost:1337/streams bun run test`
3. Verify all 131 tests still pass

## Implementation Order

1. ✅ Create worktree
2. ✅ Copy documentation
3. Rename `StreamProtocolImpl` → `StreamProtocol`
4. Update protocol interface (add streamId parameter)
5. Refactor protocol implementation (factory pattern)
6. Refactor HttpHandler (receive protocol, pass streamId)
7. Update index.ts (composition root, import env from alchemy)
8. Move types package into server
9. Update storage.ts env interface
10. Run tests
11. Verify everything works

## Success Criteria

- All TypeScript compiles without errors
- All 131 conformance tests pass
- Dev server works correctly
- Clean separation: index.ts does DI, HttpHandler routes, Protocol implements logic, Storage persists
- No separate types package
- Env types imported from alchemy.run.ts
