---
date: 2025-12-24
project: "[[projects/durable-streams]]"
tags:
  - durable-streams
  - storage
  - durable-objects
  - sqlite
---

# Storage Layer

The storage layer handles persistence, offset generation, TTL management, and wait/notify for live reads.

Uses SQLite-backed Durable Objects with the **synchronous KV API** (`ctx.storage.kv`).

See [[types]] for type definitions.

## Interface

All methods are async to support flexible implementations (cached storage, remote storage, etc.).

```typescript
interface StreamStorage {
  // Lifecycle
  createStream(options: {
    contentType: string
    ttlSeconds?: number
    expiresAt?: string
    initialData?: Uint8Array[]
  }): Promise<string>  // returns nextOffset
  
  deleteAll(): Promise<void>
  
  // Metadata
  getMetadata(): Promise<StreamMetadata | null>
  getCurrentOffset(): Promise<string>
  
  // Messages
  append(messages: Uint8Array[], seq?: string): Promise<string>  // returns nextOffset
  read(afterOffset?: string): Promise<{ 
    messages: StoredMessage[]
    nextOffset: string
    upToDate: boolean 
  }>
  
  // Live reads (waits for new messages)
  readLive(afterOffset: string, signal?: AbortSignal): Promise<{ 
    messages: StoredMessage[]
    nextOffset: string
    timedOut: boolean 
  }>
}
```

## SQLite-backed DO Storage APIs

SQLite-backed DOs provide two storage options:

### Synchronous KV API (`ctx.storage.kv`)
- `ctx.storage.kv.get(key)` - returns value directly
- `ctx.storage.kv.put(key, value)` - void
- `ctx.storage.kv.delete(key)` - returns boolean
- `ctx.storage.kv.list(options)` - returns Iterable

### SQL API (`ctx.storage.sql`)
- `ctx.storage.sql.exec(query, ...bindings)` - returns cursor

Both are synchronous. We use the KV API for simplicity, but could switch to SQL for more complex queries.

## Implementation Notes

### Offset Format

Counter-based, zero-padded for lexicographic sorting:

```
{counter}_{byte-offset}
Example: 0000000000000000_0000000000000100
```

Both components are 16-digit zero-padded decimals.

### Storage Keys

```
metadata          -> StreamMetadata
counter           -> number
currentOffset     -> string
message:{offset}  -> StoredMessage
```

Using `message:` prefix allows efficient range queries via `kv.list()`.

### Implementation - Synchronous Operations

The DO implementation uses sync KV operations internally, but wraps them in async methods for interface compatibility.

```typescript
class DOStreamStorage implements StreamStorage {
  private kv: DurableObjectStorageKV
  
  constructor(private ctx: DurableObjectState) {
    this.kv = ctx.storage.kv
  }

  async append(messages: Uint8Array[], seq?: string): Promise<string> {
    let counter = this.kv.get<number>('counter') ?? 0
    let lastOffset = ''
    
    for (const data of messages) {
      counter++
      const offset = this.formatOffset(counter)
      lastOffset = offset
      
      this.kv.put(`message:${offset}`, {
        data,
        offset,
        timestamp: Date.now()
      })
    }
    
    this.kv.put('counter', counter)
    this.kv.put('currentOffset', lastOffset)
    
    if (seq) {
      const meta = this.kv.get<StreamMetadata>('metadata')!
      this.kv.put('metadata', { ...meta, lastSeq: seq })
    }
    
    // Notify waiters
    this.notifyWaiters()
    
    return lastOffset
  }
  
  async getMetadata(): Promise<StreamMetadata | null> {
    return this.kv.get<StreamMetadata>('metadata') ?? null
  }
  
  async getCurrentOffset(): Promise<string> {
    return this.kv.get<string>('currentOffset') ?? this.formatOffset(0)
  }
  
  private formatOffset(counter: number): string {
    return `${String(counter).padStart(16, '0')}_${'0'.repeat(16)}`
  }
}
```

### Transactional Writes (if needed)

For operations that must be atomic across multiple keys:

```typescript
ctx.storage.transactionSync(() => {
  // All synchronous operations here are atomic
  const counter = this.kv.get<number>('counter') ?? 0
  this.kv.put('counter', counter + 1)
  this.kv.put(`message:${offset}`, message)
})
```

### Wait/Notify for Live Reads

The only async operation - waiting for new messages:

```typescript
private waiters: Set<() => void> = new Set()

async readLive(
afterOffset: string, 
signal?: AbortSignal
): Promise<{ messages: StoredMessage[], nextOffset: string, timedOut: boolean }> {
// Check for existing messages
const result = await this.read(afterOffset)
if (result.messages.length > 0) {
return { ...result, timedOut: false }
}
  
  // Wait for new messages or timeout
  const timeout = 30_000
  
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      this.waiters.delete(notify)
      resolve({ 
        messages: [], 
        nextOffset: result.nextOffset, 
        timedOut: true 
      })
    }, timeout)
    
    const notify = async () => {
      clearTimeout(timeoutId)
      this.waiters.delete(notify)
      const r = await this.read(afterOffset)
      resolve({ ...r, timedOut: false })
    }
    
    this.waiters.add(notify)
    
    signal?.addEventListener('abort', () => {
      clearTimeout(timeoutId)
      this.waiters.delete(notify)
      resolve({ 
        messages: [], 
        nextOffset: result.nextOffset, 
        timedOut: true 
      })
    })
  })
}

private notifyWaiters() {
  for (const waiter of this.waiters) {
    waiter()
  }
}
```

### TTL via Alarms

```typescript
async createStream(options: CreateStreamOptions): Promise<string> {
  const metadata: StreamMetadata = {
    contentType: options.contentType,
    ttlSeconds: options.ttlSeconds,
    expiresAt: options.expiresAt,
    createdAt: Date.now()
  }
  
  this.kv.put('metadata', metadata)
  this.kv.put('counter', 0)
  this.kv.put('currentOffset', this.formatOffset(0))
  
  // Set alarm for TTL (async but fire-and-forget)
  if (options.ttlSeconds) {
    this.ctx.storage.setAlarm(Date.now() + options.ttlSeconds * 1000)
  } else if (options.expiresAt) {
    this.ctx.storage.setAlarm(new Date(options.expiresAt).getTime())
  }
  
  // Handle initial data
  if (options.initialData?.length) {
    return await this.append(options.initialData)
  }
  
  return this.formatOffset(0)
}

async deleteAll(): Promise<void> {
  // Clear all waiters
  for (const waiter of this.waiters) {
    waiter()  // Resolve with empty
  }
  this.waiters.clear()
  
  // Delete all storage - async but we don't need to wait
  this.ctx.storage.deleteAll()
}
```

### Reading Messages

```typescript
async read(afterOffset?: string): Promise<{
  messages: StoredMessage[]
  nextOffset: string
  upToDate: boolean
}> {
  const currentOffset = await this.getCurrentOffset()
  
  const listOptions: { prefix: string, startAfter?: string } = {
    prefix: 'message:'
  }
  
  if (afterOffset) {
    listOptions.startAfter = `message:${afterOffset}`
  }
  
  const entries = this.kv.list<StoredMessage>(listOptions)
  const messages = Array.from(entries).map(([_, v]) => v)
  
  const nextOffset = messages.length > 0
    ? messages[messages.length - 1].offset
    : currentOffset
  
  return {
    messages,
    nextOffset,
    upToDate: nextOffset === currentOffset
  }
}
```

### Note on Offset Byte Component

The byte-offset component is currently unused (always 0). Reserved for future use if we need sub-message positioning.
