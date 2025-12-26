---
date: 2025-12-24
project: "[[projects/durable-streams]]"
tags:
  - durable-streams
  - typescript
  - types
---

# Durable Streams Types

TypeScript type definitions for the protocol and storage layers.

## Stored Data

```typescript
interface StoredMessage {
  data: Uint8Array
  offset: string
  timestamp: number
}

interface StreamMetadata {
  contentType: string
  ttlSeconds?: number
  expiresAt?: string
  createdAt: number
  lastSeq?: string
}
```

## Protocol Inputs

```typescript
interface CreateOptions {
  contentType?: string        // defaults to application/octet-stream
  ttlSeconds?: number
  expiresAt?: string          // RFC 3339
  initialData?: Uint8Array
}

interface AppendOptions {
  data: Uint8Array            // must not be empty
  contentType: string         // must match stream
  seq?: string                // optional sequence coordination
}

interface ReadOptions {
  offset?: string             // undefined or "-1" = beginning
}

interface ReadLiveOptions {
  offset: string              // required for live modes
  mode: 'long-poll' | 'sse'
  cursor?: string
  signal?: AbortSignal        // for cancellation
}
```

## Protocol Outputs

```typescript
interface CreateResult {
  status: 'created' | 'exists' | 'conflict'
  nextOffset: string
  contentType: string
}

interface AppendResult {
  status: 'ok' | 'conflict' | 'not-found'
  nextOffset?: string
  conflictReason?: 'content-type' | 'sequence'
}

interface ReadResult {
  status: 'ok' | 'not-found' | 'gone'
  messages: StoredMessage[]
  nextOffset: string
  upToDate: boolean
}

interface ReadLiveResult {
  status: 'ok' | 'timeout' | 'not-found'
  messages: StoredMessage[]
  nextOffset: string
  upToDate: boolean
  cursor: string
}

interface MetadataResult {
  status: 'ok' | 'not-found'
  contentType?: string
  nextOffset?: string
  ttlSeconds?: number
  expiresAt?: string
}

interface DeleteResult {
  status: 'ok' | 'not-found'
}
```
