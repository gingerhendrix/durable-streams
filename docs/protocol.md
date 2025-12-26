---
date: 2025-12-24
project: "[[projects/durable-streams]]"
tags:
  - durable-streams
  - protocol
  - implementation
---

# Protocol Layer

The protocol layer handles business logic: validation, JSON mode processing, cursor generation, and orchestration between HTTP and storage.

See [[types]] for type definitions.

## Interface

All operations are async to support flexible storage implementations.

```typescript
interface StreamProtocol {
  create(options: CreateOptions): Promise<CreateResult>
  append(options: AppendOptions): Promise<AppendResult>
  read(options: ReadOptions): Promise<ReadResult>
  readLive(options: ReadLiveOptions): Promise<ReadLiveResult>
  metadata(): Promise<MetadataResult>
  delete(): Promise<DeleteResult>
}
```

## Implementation Sketch

All protocol methods are now async since they call async storage methods.

```typescript
class StreamProtocolImpl implements StreamProtocol {
  
  constructor(private storage: StreamStorage) {}

  async create(options: CreateOptions): Promise<CreateResult> {
    const existing = await this.storage.getMetadata()
    
    if (existing) {
      if (!this.configMatches(existing, options)) {
        return { status: 'conflict', nextOffset: '', contentType: '' }
      }
      const offset = await this.storage.getCurrentOffset()
      return { status: 'exists', nextOffset: offset, contentType: existing.contentType }
    }
    
    const contentType = options.contentType ?? 'application/octet-stream'
    
    // Storage handles TTL alarm setup internally
    const nextOffset = await this.storage.createStream({
      contentType,
      ttlSeconds: options.ttlSeconds,
      expiresAt: options.expiresAt,
      initialData: options.initialData 
        ? this.processData(options.initialData, contentType)
        : undefined
    })
    
    return { status: 'created', nextOffset, contentType }
  }

  async append(options: AppendOptions): Promise<AppendResult> {
    const metadata = await this.storage.getMetadata()
    
    if (!metadata) {
      return { status: 'not-found' }
    }
    
    if (!this.contentTypeMatches(metadata.contentType, options.contentType)) {
      return { status: 'conflict', conflictReason: 'content-type' }
    }
    
    if (options.seq && metadata.lastSeq && options.seq <= metadata.lastSeq) {
      return { status: 'conflict', conflictReason: 'sequence' }
    }
    
    const processed = this.processData(options.data, metadata.contentType)
    
    // Storage handles offset generation, persistence, and notifying waiters
    const nextOffset = await this.storage.append(processed, options.seq)
    
    return { status: 'ok', nextOffset }
  }

  async read(options: ReadOptions): Promise<ReadResult> {
    const metadata = await this.storage.getMetadata()
    
    if (!metadata) {
      return { status: 'not-found', messages: [], nextOffset: '', upToDate: false }
    }
    
    const offset = this.normalizeOffset(options.offset)
    const { messages, nextOffset, upToDate } = await this.storage.read(offset)
    
    return { status: 'ok', messages, nextOffset, upToDate }
  }

  async readLive(options: ReadLiveOptions): Promise<ReadLiveResult> {
    const metadata = await this.storage.getMetadata()
    
    if (!metadata) {
      return { status: 'not-found', messages: [], nextOffset: '', upToDate: false, cursor: '' }
    }
    
    // Storage handles wait logic internally
    const { messages, nextOffset, timedOut } = await this.storage.readLive(
      options.offset,
      options.signal
    )
    
    return {
      status: timedOut ? 'timeout' : 'ok',
      messages,
      nextOffset,
      upToDate: true,
      cursor: this.generateCursor(options.cursor)
    }
  }

  async metadata(): Promise<MetadataResult> {
    const meta = await this.storage.getMetadata()
    if (!meta) return { status: 'not-found' }
    
    return {
      status: 'ok',
      contentType: meta.contentType,
      nextOffset: await this.storage.getCurrentOffset(),
      ttlSeconds: meta.ttlSeconds,
      expiresAt: meta.expiresAt
    }
  }

  async delete(): Promise<DeleteResult> {
    const exists = await this.storage.getMetadata()
    if (!exists) return { status: 'not-found' }
    
    await this.storage.deleteAll()
    return { status: 'ok' }
  }

  // === Protocol-level helpers ===
  
  private processData(data: Uint8Array, contentType: string): Uint8Array[] {
    // JSON mode: validate, flatten one level, return message array
    // Binary mode: return [data]
  }
  
  private contentTypeMatches(expected: string, actual: string): boolean {
    // Case-insensitive, ignore charset
  }
  
  private configMatches(existing: StreamMetadata, options: CreateOptions): boolean {
    // Content-type, TTL, expiresAt must all match
  }
  
  private normalizeOffset(offset?: string): string | undefined {
    if (!offset || offset === '-1') return undefined
    return offset
  }
  
  private generateCursor(previous?: string): string {
    // Interval-based algorithm per spec
  }
}
```

## Helper Implementation Notes

### Cursor Generation

Interval-based algorithm from the spec:
- Divide time into 20-second intervals
- Count intervals since epoch (2024-10-09T00:00:00Z)
- Ensure monotonic progression (add jitter if client cursor >= current interval)

```typescript
const CURSOR_EPOCH = new Date('2024-10-09T00:00:00.000Z').getTime()
const CURSOR_INTERVAL_MS = 20_000

private generateCursor(previous?: string): string {
  const now = Date.now()
  const currentInterval = Math.floor((now - CURSOR_EPOCH) / CURSOR_INTERVAL_MS)
  
  if (!previous) {
    return String(currentInterval)
  }
  
  const previousInterval = parseInt(previous, 10)
  if (previousInterval < currentInterval) {
    return String(currentInterval)
  }
  
  // Add jitter: 1-3600 seconds worth of intervals
  const jitterIntervals = Math.max(1, Math.floor(Math.random() * 180))
  return String(previousInterval + jitterIntervals)
}
```

### JSON Mode Processing

```typescript
private processData(data: Uint8Array, contentType: string): Uint8Array[] {
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return [data]
  }
  
  const text = new TextDecoder().decode(data)
  const parsed = JSON.parse(text)  // throws on invalid JSON
  
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error('Empty arrays not allowed in POST')
    }
    // Flatten one level
    return parsed.map(item => 
      new TextEncoder().encode(JSON.stringify(item))
    )
  }
  
  return [new TextEncoder().encode(JSON.stringify(parsed))]
}
```

### Content-Type Matching

```typescript
private contentTypeMatches(expected: string, actual: string): boolean {
  const normalize = (ct: string) => 
    ct.toLowerCase().split(';')[0].trim()
  
  return normalize(expected) === normalize(actual)
}
```
