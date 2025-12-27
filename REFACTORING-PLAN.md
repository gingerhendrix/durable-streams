---
date: 2025-12-27
project: "[[projects/durable-streams]]"
tags:
  - durable-streams
  - refactoring
  - architecture
  - cloudflare-workers
---

# Durable Streams Refactoring Plan

## Goals

Improve the architecture by:
1. Separating concerns between storage and protocol layers
2. Making the Durable Object purely a storage implementation
3. Using dependency injection for the protocol layer
4. Optimizing performance with memoization
5. Cleaning up unused async KV operations

## Current Architecture

```
StreamDO (DurableObject)
  └─ contains StreamProtocolImpl
     └─ contains DOStreamStorage
```

**Issues:**
- StreamDO mixes HTTP handling with being a Durable Object
- Protocol layer is tightly coupled to storage
- No clear interfaces between layers
- Using async storage.get() unnecessarily
- No memoization of metadata

## Target Architecture

```
Worker fetch handler (index.ts)
  ├─ creates storageFactory from env.STREAMS binding
  ├─ creates StreamProtocol(storageFactory)
  └─ creates HttpHandler(protocol)
     └─ HttpHandler.fetch(request)
        └─ calls protocol.create/append/read/etc
           └─ protocol calls storage via factory
              └─ factory gets DO stub from env
                 └─ StreamStorage (DurableObject)
                    ├─ pure storage methods (RPC interface)
                    ├─ memoizes metadata in memory
                    └─ restores memos from storage in constructor
```

**Key points:**
- **All DI happens in index.ts** - factory, protocol, and handler created at top level
- `StreamStorage` is the DO - **pure storage only**, no protocol logic
- `StreamProtocol` receives a **factory function** to get storage stubs
- `HttpHandler` receives protocol via constructor - no creation logic
- Each layer has a single responsibility and explicit dependencies

## Refactoring Steps

### 1. Create StreamProtocolInterface

**File**: `packages/server/src/protocol.ts`

```typescript
export interface StreamProtocolInterface {
  create(contentType: string, ttl?: number, expiresAt?: number): Promise<void>;
  append(data: Uint8Array, contentType: string): Promise<AppendResult>;
  read(offset?: number, limit?: number, cursor?: string): Promise<ReadResult>;
  delete(): Promise<void>;
  getMetadata(): Promise<Metadata>;
}
```

### 2. Rename StreamProtocolImpl → StreamProtocol

**File**: `packages/server/src/protocol.ts`

- Rename class `StreamProtocolImpl` to `StreamProtocol`
- Implement `StreamProtocolInterface`
- Keep all existing logic

### 3. Refactor StreamStorage (formerly DOStreamStorage)

**File**: `packages/server/src/storage.ts`

**Changes:**

a) **Add memoization fields**:
```typescript
class StreamStorage {
  private metadata: Metadata | null = null;
  private metadataLoaded = false;
  
  // ... existing fields
}
```

b) **Load memos in constructor**:
```typescript
constructor(state: DurableObjectState, env: Env) {
  super(state, env);
  
  // Restore metadata from storage synchronously
  this.metadata = this.state.storage.kv.get('metadata') ?? null;
  this.metadataLoaded = true;
}
```

**Note**: No need for `blockConcurrencyWhile()` - synchronous KV is instant!

c) **Use synchronous KV API internally, keep async signatures**:
```typescript
async getMetadata(): Promise<Metadata | null> {
  return this.metadata; // Already loaded in constructor
}

async setMetadata(metadata: Metadata): Promise<void> {
  this.metadata = metadata;
  this.state.storage.kv.put('metadata', metadata);
}
```

**Note**: 
- Keep `async` signatures for RPC compatibility and future flexibility
- Use synchronous `ctx.storage.kv` API internally
- No extra guard in `getMetadata()` - metadata loaded once in constructor

d) **Convert to synchronous KV API internally**:
- Change `await state.storage.get()` → `state.storage.kv.get()`
- Change `await state.storage.put()` → `state.storage.kv.put()`
- Change `await state.storage.list()` → `state.storage.kv.list()` (returns Iterable, not Promise)
- Keep `async` method signatures for RPC compatibility
- Remove `await` when calling KV methods (they're synchronous)

### 4. Make StreamStorage Pure Storage DO with Synchronous KV

**File**: `packages/server/src/storage.ts`

```typescript
export class StreamStorage extends DurableObject {
  private metadata: Metadata | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    
    // Restore metadata synchronously from storage
    this.metadata = this.state.storage.kv.get('metadata') ?? null;
  }

  // Pure storage methods (RPC interface)
  // Keep async signatures for RPC compatibility and future flexibility
  async getMetadata(): Promise<Metadata | null> {
    return this.metadata; // Already loaded in constructor
  }

  async setMetadata(metadata: Metadata): Promise<void> {
    this.metadata = metadata;
    this.state.storage.kv.put('metadata', metadata);
  }

  async appendMessage(message: Message): Promise<void> {
    const key = `msg:${message.offset}`;
    this.state.storage.kv.put(key, message);
    
    // Update metadata offset counter
    if (this.metadata) {
      this.metadata.nextOffset = message.offset + 1;
      await this.setMetadata(this.metadata);
    }
  }

  async readMessages(offset?: number, limit?: number): Promise<Message[]> {
    // Use synchronous list API internally
    const options: any = {};
    if (offset !== undefined) options.startAfter = `msg:${offset - 1}`;
    if (limit !== undefined) options.limit = limit;
    
    const messages: Message[] = [];
    for (const [key, value] of this.state.storage.kv.list(options)) {
      if (key.startsWith('msg:')) {
        messages.push(value as Message);
      }
    }
    return messages;
  }
  
  async deleteStream(): Promise<void> {
    await this.state.storage.deleteAll();
    this.metadata = null;
  }
  
  // NO protocol logic, NO HTTP logic - just storage!
  // Async signatures for RPC, synchronous KV internally
}
```

**Key changes:**
- Use `ctx.storage.kv.get/put/list` (synchronous) instead of `ctx.storage.get/put/list` (async)
- Keep `async` method signatures for RPC compatibility and future flexibility
- No `await` on KV operations - they're synchronous
- `list()` returns an Iterable, use `for...of` to iterate
- Metadata loaded once in constructor, then memoized
- No extra guard in `getMetadata()` - already loaded

### 5. Create HttpHandler Class

**File**: `packages/server/src/http.ts` (new file)

```typescript
import type { StreamProtocol } from './protocol';

export class HttpHandler {
  // Protocol is injected - no creation logic here
  constructor(private protocol: StreamProtocol) {}

  async fetch(request: Request): Promise<Response> {
    // Parse request, extract stream ID
    const streamId = this.getStreamId(request);
    
    // Handle HTTP methods by calling protocol
    const method = request.method;
    
    if (method === 'PUT') {
      const contentType = request.headers.get('content-type') || 'application/octet-stream';
      const ttl = this.parseTTL(request);
      const expiresAt = this.parseExpiresAt(request);
      await this.protocol.create(streamId, contentType, ttl, expiresAt);
      return new Response(null, { status: 201 });
    }
    
    if (method === 'POST') {
      const data = new Uint8Array(await request.arrayBuffer());
      const contentType = request.headers.get('content-type') || 'application/octet-stream';
      const result = await this.protocol.append(streamId, data, contentType);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (method === 'GET') {
      const url = new URL(request.url);
      const offset = this.parseOffset(url);
      const limit = this.parseLimit(url);
      const result = await this.protocol.read(streamId, offset, limit);
      return this.formatReadResponse(result, request);
    }
    
    // ... other HTTP methods
  }
  
  private getStreamId(request: Request): string {
    // Extract from URL path
  }
}
```

### 6. Update Main Index File (DI Composition Root)

**File**: `packages/server/src/index.ts`

```typescript
import { HttpHandler } from './http';
import { StreamProtocol } from './protocol';
import { StreamStorage } from './storage';
import type { DurableObjectStub } from '@cloudflare/workers-types';

// Re-export the DO
export { StreamStorage };

// Worker fetch handler - composition root for DI
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Create storage factory from env binding
    const storageFactory = (streamId: string): DurableObjectStub<StreamStorage> => {
      const id = env.STREAMS.idFromName(streamId);
      return env.STREAMS.get(id);
    };
    
    // Create protocol with factory
    const protocol = new StreamProtocol(storageFactory);
    
    // Create handler with protocol
    const handler = new HttpHandler(protocol);
    
    // Execute request
    return handler.fetch(request);
  }
};
```

### 7. Update Protocol to Use Storage Factory

**File**: `packages/server/src/protocol.ts`

```typescript
import type { StreamStorage } from './storage';

type StorageFactory = (streamId: string) => DurableObjectStub<StreamStorage>;

export interface StreamProtocolInterface {
  create(streamId: string, contentType: string, ttl?: number, expiresAt?: number): Promise<void>;
  append(streamId: string, data: Uint8Array, contentType: string): Promise<AppendResult>;
  read(streamId: string, offset?: number, limit?: number, cursor?: string): Promise<ReadResult>;
  delete(streamId: string): Promise<void>;
}

export class StreamProtocol implements StreamProtocolInterface {
  constructor(private getStorage: StorageFactory) {}
  
  async create(streamId: string, contentType: string, ttl?: number, expiresAt?: number): Promise<void> {
    // Get storage stub for this stream
    const storage = this.getStorage(streamId);
    
    // Check if already exists
    const existing = await storage.getMetadata();
    if (existing) {
      throw new Error('Stream already exists');
    }
    
    // Create metadata
    const metadata: Metadata = {
      contentType,
      nextOffset: 0,
      createdAt: Date.now(),
      ttl,
      expiresAt,
    };
    
    await storage.setMetadata(metadata);
  }
  
  async append(streamId: string, data: Uint8Array, contentType: string): Promise<AppendResult> {
    const storage = this.getStorage(streamId);
    
    // Get metadata to determine offset
    const metadata = await storage.getMetadata();
    if (!metadata) {
      throw new Error('Stream not found');
    }
    
    // Validate content type matches
    if (metadata.contentType !== contentType) {
      throw new Error('Content-Type mismatch');
    }
    
    // Create message
    const message: Message = {
      offset: metadata.nextOffset,
      data,
      timestamp: Date.now(),
    };
    
    await storage.appendMessage(message);
    
    return {
      offset: message.offset,
      timestamp: message.timestamp,
    };
  }
  
  // ... other protocol methods using this.getStorage(streamId)
}
```

## Implementation Order

1. ✅ **Create interface** - Add `StreamProtocolInterface`
2. ✅ **Rename class** - `StreamProtocolImpl` → `StreamProtocol`
3. ✅ **Add memoization** - Metadata caching in StreamStorage
4. ✅ **Refactor constructor** - Load memos on initialization
5. ✅ **Remove unused async ops** - Clean up unnecessary `storage.get()` calls
6. ✅ **Add RPC interface** - StreamStorage exposes RPC methods
7. ✅ **Create HttpHandler** - New http.ts with HttpHandler class
8. ✅ **Update index.ts** - Re-export DO, create fetch handler
9. ✅ **Dependency injection** - StreamStorage receives StreamProtocol
10. ✅ **Update alchemy.run.ts** - Use StreamStorage as DO
11. ✅ **Test** - Run full conformance suite

## Testing Strategy

After each step:
1. Run `bun run test` locally
2. Verify all 131 tests still pass
3. Check dev server still works: `bun run dev`

## Migration Checklist

- [ ] Create StreamProtocolInterface
- [ ] Rename StreamProtocolImpl → StreamProtocol
- [ ] Add memoization fields to StreamStorage
- [ ] Implement constructor memoization loading
- [ ] Memoize getMetadata/setMetadata
- [ ] Remove unnecessary async storage.get() calls
- [ ] Make StreamStorage extend DurableObject with RPC interface
- [ ] Inject StreamProtocol into StreamStorage constructor
- [ ] Create http.ts with HttpHandler class
- [ ] Update index.ts to re-export DO and create fetch handler
- [ ] Update alchemy.run.ts to use StreamStorage
- [ ] Run conformance tests
- [ ] Update documentation

## Expected Benefits

1. **Clearer separation of concerns** - Storage vs Protocol vs HTTP
2. **Better testability** - Can mock storage interface
3. **Performance improvement** - Memoized metadata access
4. **Reduced async overhead** - Fewer unnecessary storage.get() calls
5. **More maintainable** - Dependencies are explicit via constructor

## Risks

- **Breaking changes** - Need to update all exports
- **State initialization** - Memoization in constructor must not block
- **Test failures** - Must maintain 100% test coverage throughout

## Next Steps

Delegate to claude-code agent to implement this refactoring in steps, running tests after each major change.
