---
date: 2025-12-24
project: "[[projects/durable-streams]]"
tags:
  - http
  - api-spec
  - protocol
  - durable-streams
  - cloudflare-workers
---

# Durable Streams HTTP API Specification

Complete HTTP API reference for implementing a Durable Streams server. This document specifies all HTTP operations, headers, parameters, and behaviors required for protocol compliance.

## Base Concepts

### Stream Model

A stream is a URL-addressable, append-only byte stream with:

- **Durability**: Bytes persist once written and acknowledged
- **Immutability by Position**: Bytes at a given offset never change
- **Ordering**: Bytes are strictly ordered by offset
- **Content Type**: Each stream has a MIME content type set at creation
- **TTL/Expiry**: Optional time-to-live or absolute expiry times

### URL Structure

The protocol does not prescribe URL structure. Servers may use any scheme:
- `/v1/stream/{path}`
- `/streams/{id}`
- Domain-specific paths

The protocol is defined by HTTP methods, query parameters, and headers applied to stream URLs.

## HTTP Operations

### 1. Create Stream (PUT)

Creates a new stream at the specified URL.

#### Request

```http
PUT {stream-url}
Content-Type: <stream-content-type>
Stream-TTL: <seconds>                   (optional)
Stream-Expires-At: <rfc3339>           (optional)

<optional-initial-data>
```

#### Request Headers

| Header | Required | Format | Description |
|--------|----------|--------|-------------|
| `Content-Type` | No | MIME type | Stream content type. Default: `application/octet-stream` |
| `Stream-TTL` | No | Integer | Time-to-live in seconds. MUST NOT have leading zeros, plus signs, decimals, or scientific notation |
| `Stream-Expires-At` | No | RFC 3339 | Absolute expiry timestamp |

**Header Constraints:**
- Cannot specify both `Stream-TTL` and `Stream-Expires-At` (returns 400)
- `Stream-TTL` MUST match pattern: `^(0|[1-9]\d*)$`
- Invalid content-type format defaults to `application/octet-stream`

#### Request Body

Optional initial stream bytes. If provided, these become the first content of the stream.

#### Response Codes

| Code | Meaning |
|------|---------|
| `201 Created` | New stream created successfully |
| `200 OK` or `204 No Content` | Stream exists with matching configuration (idempotent) |
| `409 Conflict` | Stream exists with different configuration |
| `400 Bad Request` | Invalid headers or parameters |
| `429 Too Many Requests` | Rate limit exceeded |

#### Response Headers

| Header | When | Format | Description |
|--------|------|--------|-------------|
| `Location` | On 201 | URL | The stream URL |
| `Content-Type` | On 201/200 | MIME type | The stream's content type |
| `Stream-Next-Offset` | On 201/200 | Offset token | Tail offset after any initial content |

#### Examples

**Create empty stream:**
```http
PUT /v1/stream/my-stream
Content-Type: text/plain

→ 201 Created
Location: http://example.com/v1/stream/my-stream
Content-Type: text/plain
Stream-Next-Offset: 0000000000000000_0000000000000000
```

**Create with initial data:**
```http
PUT /v1/stream/logs
Content-Type: text/plain

Initial log entry

→ 201 Created
Content-Type: text/plain
Stream-Next-Offset: 0000000000000000_0000000000000018
```

**Idempotent create (same config):**
```http
PUT /v1/stream/existing
Content-Type: text/plain

→ 200 OK
Content-Type: text/plain
Stream-Next-Offset: 0000000000000000_0000000000000000
```

**Config conflict:**
```http
PUT /v1/stream/existing
Content-Type: application/json

→ 409 Conflict
```

### 2. Append to Stream (POST)

Appends bytes to an existing stream.

#### Request

```http
POST {stream-url}
Content-Type: <stream-content-type>
Stream-Seq: <sequence-token>           (optional)
Transfer-Encoding: chunked             (optional)

<data-to-append>
```

#### Request Headers

| Header | Required | Format | Description |
|--------|----------|--------|-------------|
| `Content-Type` | Yes | MIME type | MUST match stream's content type |
| `Stream-Seq` | No | Opaque string | Monotonic sequence number for writer coordination |
| `Transfer-Encoding` | No | `chunked` | Enables streaming append |

**Sequence Number Semantics:**
- Opaque strings compared lexicographically
- MUST be strictly increasing: `seq > lastSeq`
- Scoped per authenticated writer or per stream (implementation-defined)
- Example progression: `001`, `002`, `003` or `09`, `10`, `11`
- Invalid progression: `2`, `10` (lexicographically `10` < `2`)

#### Request Body

Bytes to append. MUST NOT be empty (returns 400).

For `application/json` streams, see JSON Mode section.

#### Response Codes

| Code | Meaning |
|------|---------|
| `200 OK` or `204 No Content` | Append successful |
| `400 Bad Request` | Empty body, missing Content-Type, or invalid format |
| `404 Not Found` | Stream does not exist |
| `405 Method Not Allowed` or `501 Not Implemented` | Append not supported |
| `409 Conflict` | Content-Type mismatch or sequence regression |
| `413 Payload Too Large` | Body exceeds server limits |
| `429 Too Many Requests` | Rate limit exceeded |

#### Response Headers

| Header | When | Format | Description |
|--------|------|--------|-------------|
| `Stream-Next-Offset` | On success | Offset token | New tail offset after append |

#### Examples

**Append text:**
```http
POST /v1/stream/logs
Content-Type: text/plain

New log entry

→ 200 OK
Stream-Next-Offset: 0000000000000000_0000000000000030
```

**Sequence coordination:**
```http
POST /v1/stream/events
Content-Type: text/plain
Stream-Seq: 001

First event

→ 200 OK
Stream-Next-Offset: 0000000000000000_0000000000000011
```

**Sequence conflict:**
```http
POST /v1/stream/events
Content-Type: text/plain
Stream-Seq: 001

Duplicate

→ 409 Conflict
Sequence conflict: 001 <= 001
```

**Content-Type mismatch:**
```http
POST /v1/stream/logs
Content-Type: application/json

{"invalid": true}

→ 409 Conflict
Content-type mismatch: expected text/plain, got application/json
```

### 3. Delete Stream (DELETE)

Deletes a stream and all its data.

#### Request

```http
DELETE {stream-url}
```

#### Response Codes

| Code | Meaning |
|------|---------|
| `204 No Content` | Stream deleted successfully |
| `404 Not Found` | Stream does not exist |
| `405 Method Not Allowed` or `501 Not Implemented` | Delete not supported |

#### Isolation After Delete

A new stream MAY be created at the same URL after deletion, but it SHOULD be completely isolated from the deleted stream. The new stream:
- MUST start with offset `0000000000000000_0000000000000000`
- MUST NOT contain any data from the deleted stream
- MUST NOT share sequence numbers or cursors

### 4. Stream Metadata (HEAD)

Retrieves stream metadata without transferring data.

#### Request

```http
HEAD {stream-url}
```

#### Response Codes

| Code | Meaning |
|------|---------|
| `200 OK` | Stream exists |
| `404 Not Found` | Stream does not exist |
| `429 Too Many Requests` | Rate limit exceeded |

#### Response Headers

| Header | When | Format | Description |
|--------|------|--------|-------------|
| `Content-Type` | Always | MIME type | Stream's content type |
| `Stream-Next-Offset` | Always | Offset token | Current tail offset |
| `Stream-TTL` | Optional | Seconds | Remaining time-to-live |
| `Stream-Expires-At` | Optional | RFC 3339 | Absolute expiry time |
| `ETag` | Always | Quoted string | Entity tag: `"{path_base64}:-1:{offset}"` |
| `Cache-Control` | Always | Directive | SHOULD be `no-store` or `private, max-age=0` |

#### Example

```http
HEAD /v1/stream/my-stream

→ 200 OK
Content-Type: text/plain
Stream-Next-Offset: 0000000000000000_0000000000000100
ETag: "L3YxL3N0cmVhbS9teS1zdHJlYW0=-1:0000000000000000_0000000000000100"
Cache-Control: no-store
```

### 5. Read Stream - Catch-up (GET)

Reads bytes from a specified offset.

#### Request

```http
GET {stream-url}?offset=<offset>
If-None-Match: <etag>                  (optional)
```

#### Query Parameters

| Parameter | Required | Format | Description |
|-----------|----------|--------|-------------|
| `offset` | No | Offset token or `-1` | Start position. Omit for stream beginning |

**Offset Validation:**
- `-1` is special sentinel for stream beginning (equivalent to omitting)
- MUST match pattern: `^(-1|\d+_\d+)$`
- Empty offset (`offset=`) returns 400
- Multiple offset parameters return 400
- Invalid characters (`,`, `/`, `\0`, etc.) return 400

#### Request Headers

| Header | Required | Format | Description |
|--------|----------|--------|-------------|
| `If-None-Match` | No | ETag value | Conditional request for caching |

#### Response Codes

| Code | Meaning |
|------|---------|
| `200 OK` | Data available (may be empty if at tail) |
| `304 Not Modified` | ETag matches (no body returned) |
| `400 Bad Request` | Malformed offset or invalid parameters |
| `404 Not Found` | Stream does not exist |
| `410 Gone` | Offset before earliest retained position |
| `429 Too Many Requests` | Rate limit exceeded |

#### Response Headers

| Header | When | Format | Description |
|--------|------|--------|-------------|
| `Content-Type` | Always | MIME type | Stream's content type |
| `Stream-Next-Offset` | Always | Offset token | Next offset to read from |
| `Stream-Up-To-Date` | When caught up | `true` | Present when response includes all available data |
| `ETag` | Always | Quoted string | `"{path_base64}:{start_offset}:{end_offset}"` |
| `Cache-Control` | Always | Directive | Caching policy (see Caching section) |
| `Content-Encoding` | If compressed | `gzip` or `deflate` | Compression applied |
| `Vary` | If compressed | `accept-encoding` | Response varies by Accept-Encoding |

**Stream-Up-To-Date Semantics:**
- MUST be present and `true` when returned data reaches stream tail
- SHOULD NOT be present when returning partial data due to chunk size limits
- Signals to clients they can transition to live tailing

#### Response Body

Bytes from the stream starting at offset, up to server-defined chunk size.

For `application/json` streams, body is a JSON array of messages.

#### Examples

**Read from beginning:**
```http
GET /v1/stream/logs

→ 200 OK
Content-Type: text/plain
Stream-Next-Offset: 0000000000000000_0000000000000100
Stream-Up-To-Date: true
ETag: "L29ncy1zdHJlYW0=-1:0000000000000000_0000000000000100"

<stream data>
```

**Read from offset:**
```http
GET /v1/stream/logs?offset=0000000000000000_0000000000000050

→ 200 OK
Content-Type: text/plain
Stream-Next-Offset: 0000000000000000_0000000000000100
Stream-Up-To-Date: true
ETag: "L29ncy1zdHJlYW0=0000000000000000_0000000000000050:0000000000000000_0000000000000100"

<data from offset 50>
```

**Conditional GET (304):**
```http
GET /v1/stream/logs
If-None-Match: "L29ncy1zdHJlYW0=-1:0000000000000000_0000000000000100"

→ 304 Not Modified
ETag: "L29ncy1zdHJlYW0=-1:0000000000000000_0000000000000100"
```

**Read at tail (empty):**
```http
GET /v1/stream/logs?offset=0000000000000000_0000000000000100

→ 200 OK
Content-Type: text/plain
Stream-Next-Offset: 0000000000000000_0000000000000100
Stream-Up-To-Date: true

```

### 6. Read Stream - Live Long-Poll (GET)

Long-polls for new data if none available at specified offset.

#### Request

```http
GET {stream-url}?offset=<offset>&live=long-poll&cursor=<cursor>
```

#### Query Parameters

| Parameter | Required | Format | Description |
|-----------|----------|--------|-------------|
| `offset` | Yes | Offset token | MUST be provided for long-poll |
| `live` | Yes | `long-poll` | Enables long-poll mode |
| `cursor` | No | Cursor token | Echo of previous `Stream-Cursor` header |

#### Response Codes

| Code | Meaning |
|------|---------|
| `200 OK` | Data became available within timeout |
| `204 No Content` | Timeout expired with no new data |
| `400 Bad Request` | Missing offset or invalid parameters |
| `404 Not Found` | Stream does not exist |
| `429 Too Many Requests` | Rate limit exceeded |

#### Response Headers (200 OK)

Same as catch-up read (section 5), plus:

| Header | When | Format | Description |
|--------|------|--------|-------------|
| `Stream-Cursor` | Always | Cursor token | For CDN collapsing (see Caching section) |

#### Response Headers (204 No Content)

| Header | When | Format | Description |
|--------|------|--------|-------------|
| `Stream-Next-Offset` | Always | Offset token | Current tail offset |
| `Stream-Up-To-Date` | Always | `true` | Client is caught up |
| `Stream-Cursor` | Always | Cursor token | For CDN collapsing |

#### Long-Poll Behavior

1. If data exists beyond offset: return immediately with 200
2. If no data: wait up to timeout for new data
3. If data arrives during wait: return 200 with data
4. If timeout expires: return 204 with current offset

Timeout duration is implementation-defined (typically 30 seconds).

#### Examples

**Data available immediately:**
```http
GET /v1/stream/logs?offset=0000000000000000_0000000000000100&live=long-poll

→ 200 OK
Content-Type: text/plain
Stream-Next-Offset: 0000000000000000_0000000000000150
Stream-Up-To-Date: true
Stream-Cursor: 12345

<new data>
```

**Timeout with no data:**
```http
GET /v1/stream/logs?offset=0000000000000000_0000000000000100&live=long-poll&cursor=12345

→ 204 No Content
Stream-Next-Offset: 0000000000000000_0000000000000100
Stream-Up-To-Date: true
Stream-Cursor: 12350
```

**Missing offset:**
```http
GET /v1/stream/logs?live=long-poll

→ 400 Bad Request
Long-poll requires offset parameter
```

### 7. Read Stream - Live SSE (GET)

Streams data as Server-Sent Events.

#### Request

```http
GET {stream-url}?offset=<offset>&live=sse&cursor=<cursor>
Accept: text/event-stream
```

#### Query Parameters

| Parameter | Required | Format | Description |
|-----------|----------|--------|-------------|
| `offset` | Yes | Offset token | MUST be provided for SSE |
| `live` | Yes | `sse` | Enables SSE mode |
| `cursor` | No | Cursor token | Echo of previous cursor |

#### Content-Type Constraints

SSE mode is ONLY valid for streams with:
- `content-type: text/*`
- `content-type: application/json`

Servers MUST return 400 for binary content types.

#### Response Codes

| Code | Meaning |
|------|---------|
| `200 OK` | SSE stream started |
| `400 Bad Request` | Invalid content type, missing offset, or invalid parameters |
| `404 Not Found` | Stream does not exist |
| `429 Too Many Requests` | Rate limit exceeded |

#### Response Headers

| Header | Value | Description |
|--------|-------|-------------|
| `Content-Type` | `text/event-stream` | SSE content type |
| `Cache-Control` | `no-cache` | Prevent buffering |
| `Connection` | `keep-alive` | Maintain connection |

#### SSE Event Format

**Data Events:**
```
event: data
data: <line1>
data: <line2>
...

```

For `application/json` streams, data MAY be batched as JSON array across multiple `data:` lines:
```
event: data
data: [
data: {"msg":"one"},
data: {"msg":"two"}
data: ]

```

**Control Events:**
```
event: control
data: {"streamNextOffset":"<offset>","streamCursor":"<cursor>","upToDate":true}

```

Control event fields (camelCase):
- `streamNextOffset` (required): Next offset to read
- `streamCursor` (required): Cursor for CDN collapsing
- `upToDate` (optional): Present and `true` when caught up

#### Connection Lifecycle

1. Server sends data event(s) for available messages
2. Server sends control event with current offset
3. If caught up, server waits for new data
4. On timeout (typically 60s), server sends keep-alive control event
5. Server SHOULD close connection roughly every 60s for CDN collapsing
6. Client reconnects using last received `streamNextOffset`

#### Examples

**SSE stream with data:**
```http
GET /v1/stream/logs?offset=-1&live=sse
Accept: text/event-stream

→ 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache

event: data
data: Log line 1
data: Log line 2

event: control
data: {"streamNextOffset":"0000000000000000_0000000000000025","streamCursor":"12345","upToDate":true}

```

**JSON stream batching:**
```http
GET /v1/stream/events?offset=-1&live=sse

→ 200 OK
Content-Type: text/event-stream

event: data
data: [
data: {"id":1,"msg":"hello"},
data: {"id":2,"msg":"world"}
data: ]

event: control
data: {"streamNextOffset":"0000000000000000_0000000000000050","streamCursor":"12346"}

```

**Keep-alive on timeout:**
```
event: control
data: {"streamNextOffset":"0000000000000000_0000000000000100","streamCursor":"12350","upToDate":true}

```

**Binary content type rejection:**
```http
GET /v1/stream/binary?offset=-1&live=sse

→ 400 Bad Request
SSE mode requires text/* or application/json content type
```

## Offsets

### Format

Offsets are opaque, case-sensitive strings with these properties:

1. **Opaque**: Clients MUST NOT interpret internal structure
2. **Lexicographically Sortable**: String comparison determines ordering
3. **Persistent**: Valid for stream lifetime (until deletion/expiration)
4. **Unique**: Each position has exactly one offset
5. **Strictly Increasing**: New offsets MUST be greater than all previous

**Restrictions:**
- MUST NOT contain: `,`, `&`, `=`, `?`, `/`, `\0`, spaces, newlines
- SHOULD be URL-safe to avoid encoding issues
- SHOULD be under 256 characters
- Clients MUST URL-encode offsets in query parameters

**Sentinel Value:**
- `-1` represents stream beginning (equivalent to omitting offset)

**Implementation Format:**
```
<read-seq>_<byte-offset>

Example: 0000000000000000_0000000000000100
```

Both components are zero-padded for lexicographic sorting.

### Usage

Clients MUST:
1. Use `Stream-Next-Offset` from responses for subsequent reads
2. Persist offsets for resumability after disconnect
3. Compare offsets lexicographically, not numerically

## Content Types

### General Semantics

The protocol supports arbitrary MIME content types. Most operate at byte level, with clients responsible for message framing.

**Restrictions:**
- SSE mode requires `text/*` or `application/json`
- Content-Type comparison is case-insensitive for media type
- Charset parameters are ignored for comparison

**Normalization:**
```
application/json; charset=utf-8 → application/json
text/plain; charset=iso-8859-1 → text/plain
```

### JSON Mode

Streams with `Content-Type: application/json` have special semantics.

#### Message Boundaries

Servers MUST preserve message boundaries. Each POST stores messages as distinct units.

#### Array Flattening

When POST body is a JSON array, servers MUST flatten exactly one level:

```
POST: {"event": "a"}           → Store 1 message: {"event": "a"}
POST: [{"event": "a"}, {"event": "b"}]  → Store 2 messages: {"event": "a"}, {"event": "b"}
POST: [[1,2], [3,4]]          → Store 2 messages: [1,2], [3,4]
POST: [[[1,2,3]]]             → Store 1 message: [[1,2,3]]
```

**Empty Array Handling:**
- PUT with `[]` is valid (creates empty stream)
- POST with `[]` returns 400 (no-op operation, likely client error)

#### Validation

Servers MUST:
1. Validate JSON syntax
2. Return 400 for invalid JSON
3. Return 400 for empty arrays in POST

#### Response Format

GET responses MUST return `Content-Type: application/json` with body as JSON array:

```json
[{"event":"a"},{"event":"b"},{"event":"c"}]
```

Empty range returns: `[]`

#### Internal Storage

Implementation stores messages with trailing commas for efficient concatenation:
```
Message 1: {"event":"a"},
Message 2: {"event":"b"},
Message 3: {"event":"c"},

Formatted response strips trailing comma and wraps: [{"event":"a"},{"event":"b"},{"event":"c"}]
```

## Caching

### Cache-Control Headers

**Catch-up and Long-Poll Reads:**

For shared, non-user-specific streams:
```
Cache-Control: public, max-age=60, stale-while-revalidate=300
```

For user-specific or confidential streams:
```
Cache-Control: private, max-age=60, stale-while-revalidate=300
```

**SSE Connections:**
```
Cache-Control: no-cache
```

**HEAD Requests:**
```
Cache-Control: no-store
```
or
```
Cache-Control: private, max-age=0, must-revalidate
```

### ETag Usage

Servers MUST generate ETags for GET responses:

**Format:**
```
ETag: "{base64(path)}:{start_offset}:{end_offset}"
```

**Conditional Requests:**
1. Client provides `If-None-Match: <etag>`
2. If matches current ETag: return 304 with no body
3. If doesn't match: return 200 with data

### Cursor Mechanism

Prevents infinite CDN cache loops by ensuring monotonic progression.

#### Cursor Generation

Servers MUST generate cursors on all live mode responses:

**Algorithm:**
1. Divide time into fixed intervals (default: 20 seconds)
2. Count intervals since epoch (default: October 9, 2024 00:00:00 UTC)
3. Return interval number as cursor string

**Implementation:**
```typescript
const epoch = new Date('2024-10-09T00:00:00.000Z')
const intervalMs = 20 * 1000
const intervalNumber = Math.floor((Date.now() - epoch.getTime()) / intervalMs)
const cursor = String(intervalNumber)
```

#### Monotonic Progression

When client provides cursor parameter:

1. If `clientCursor < currentInterval`: return `currentInterval`
2. If `clientCursor >= currentInterval`: return `clientCursor + jitter`

Jitter: random 1-3600 seconds converted to intervals (at least 1 interval)

This guarantees `responseCursor > clientCursor`, preventing A→B→A cache cycles.

#### Cursor Headers

**Long-Poll:**
```
Stream-Cursor: 12345
```

**SSE Control Events:**
```json
{"streamNextOffset":"...","streamCursor":"12345"}
```

#### Client Behavior

Clients SHOULD echo cursor in subsequent requests:
```
?offset=<offset>&live=long-poll&cursor=12345
```

### CDN Collapsing

Multiple clients waiting for same data collapse into single upstream request when:

1. Same URL (including offset and cursor parameters)
2. Appropriate Cache-Control headers
3. Authentication/credentials match (if applicable)

**Query Parameter Ordering:**
Clients SHOULD order parameters lexicographically for consistent URLs:
```
?cursor=12345&live=long-poll&offset=0000000000000000_0000000000000100
```

## Status Codes

### Success Codes

| Code | Usage |
|------|-------|
| `200 OK` | Successful GET, successful append (alternative to 204), idempotent PUT |
| `201 Created` | New stream created |
| `204 No Content` | Successful DELETE, successful append (preferred), idempotent PUT, long-poll timeout |
| `304 Not Modified` | ETag match on conditional GET |

### Client Error Codes

| Code | Causes |
|------|--------|
| `400 Bad Request` | Empty POST body, malformed offset, invalid headers, both TTL and Expires-At, invalid JSON, empty JSON array in POST, missing Content-Type in POST |
| `404 Not Found` | Stream does not exist |
| `405 Method Not Allowed` | Operation not supported for this stream |
| `409 Conflict` | Stream exists with different config, Content-Type mismatch, sequence regression |
| `410 Gone` | Offset before retention boundary |
| `413 Payload Too Large` | Request body exceeds limits |
| `429 Too Many Requests` | Rate limit exceeded |

### Server Error Codes

| Code | Causes |
|------|--------|
| `500 Internal Server Error` | Unexpected server errors |
| `501 Not Implemented` | Feature not implemented |
| `503 Service Unavailable` | Temporary unavailability |

## Header Reference

### Request Headers

| Header | Methods | Required | Format | Description |
|--------|---------|----------|--------|-------------|
| `Content-Type` | PUT, POST | POST: Yes, PUT: No | MIME type | Stream or message content type |
| `Stream-TTL` | PUT | No | Integer (0 or [1-9]\d*) | Time-to-live in seconds |
| `Stream-Expires-At` | PUT | No | RFC 3339 | Absolute expiry timestamp |
| `Stream-Seq` | POST | No | Opaque string | Sequence number for coordination |
| `Transfer-Encoding` | POST | No | `chunked` | Streaming append |
| `If-None-Match` | GET, HEAD | No | ETag value | Conditional request |
| `Accept-Encoding` | GET | No | `gzip, deflate` | Compression preferences |
| `Accept` | GET (SSE) | No | `text/event-stream` | SSE indication |

### Response Headers

| Header | Methods | When | Format | Description |
|--------|---------|------|--------|-------------|
| `Content-Type` | All | Always | MIME type | Stream content type (SSE: `text/event-stream`) |
| `Stream-Next-Offset` | PUT, POST, GET, HEAD | Success | Offset token | Next read position |
| `Stream-Up-To-Date` | GET | When caught up | `true` | All data retrieved |
| `Stream-Cursor` | GET (live) | Live modes | Cursor token | CDN collapsing cursor |
| `Stream-TTL` | HEAD | If configured | Integer | Remaining TTL seconds |
| `Stream-Expires-At` | HEAD | If configured | RFC 3339 | Absolute expiry time |
| `Location` | PUT | 201 Created | URL | Stream URL |
| `ETag` | GET, HEAD | Always | Quoted string | Cache validation |
| `Cache-Control` | All | Always | Directive | Caching policy |
| `Content-Encoding` | GET | If compressed | `gzip`, `deflate` | Compression applied |
| `Vary` | GET | If compressed | `accept-encoding` | Response variance |
| `Retry-After` | All | On 429 | Seconds or HTTP-date | Rate limit retry time |

## Query Parameters

| Parameter | Methods | Required | Format | Description |
|-----------|---------|----------|--------|-------------|
| `offset` | GET | Live: Yes, Catch-up: No | Offset token or `-1` | Start position |
| `live` | GET | No | `long-poll` or `sse` | Live mode selection |
| `cursor` | GET | No | Cursor token | CDN collapsing cursor |

## Compression

Servers SHOULD support gzip and deflate compression for responses.

### When to Compress

- Response size >= 1024 bytes (threshold)
- Client sent `Accept-Encoding` header
- Content-Type is compressible

### Headers

When compressed:
```
Content-Encoding: gzip
Vary: accept-encoding
```

### Encoding Preference

1. `gzip` (preferred - better compression, wider support)
2. `deflate`

## Protocol Edge Cases

### Empty Operations

- PUT with no body: Creates empty stream (valid)
- PUT with empty JSON array `[]`: Creates empty JSON stream (valid)
- POST with no body: Returns 400 (invalid)
- POST with empty JSON array `[]`: Returns 400 (invalid)
- GET at tail offset: Returns 200 with empty body and `Stream-Up-To-Date: true` (valid)

### Offset Validation

**Valid:**
```
-1
0000000000000000_0000000000000000
0000000000000000_0000000000000100
9999999999999999_9999999999999999
```

**Invalid (400):**
```
(empty)                    # Empty offset parameter
a,b                        # Contains comma
../path                    # Path traversal
offset=a&offset=b          # Multiple offset parameters
0 1                        # Contains space
abc                        # Doesn't match format
```

### Sequence Ordering

**Valid Progressions:**
```
001 → 002 → 003            # Numeric with padding
09 → 10 → 11               # Numeric with padding
a → b → c                  # Alphabetic
user-001 → user-002        # Prefixed
```

**Invalid (409):**
```
2 → 10                     # "10" < "2" lexicographically
A → a                      # "a" > "A" in ASCII
001 → 001                  # Equal (not strictly increasing)
002 → 001                  # Regression
```

### Content-Type Matching

**Matches (case-insensitive):**
```
text/plain ≈ text/plain
TEXT/PLAIN ≈ text/plain
application/json ≈ application/json
application/json; charset=utf-8 ≈ application/json
```

**Mismatches (409):**
```
text/plain ≠ application/json
text/plain ≠ text/html
application/json ≠ application/octet-stream
```

### Idempotent Create

Stream with same config at same URL:

**Matches (200/204):**
- Same Content-Type (case-insensitive)
- Same TTL (or both unset)
- Same Expires-At (or both unset)

**Conflicts (409):**
- Different Content-Type
- Different TTL
- Different Expires-At
- One has TTL, other has Expires-At

### Binary Data

Servers MUST preserve all byte values (0x00-0xFF) exactly.

No special handling for:
- Null bytes (0x00)
- Control characters
- High-byte values (0x80-0xFF)

### Deletion Isolation

After DELETE, recreating at same URL:
- MUST start with fresh offset
- MUST NOT contain old data
- MUST NOT share sequence state
- Effectively a completely new stream

## Implementation Notes

### Read Consistency

Servers MUST ensure read-your-writes consistency:
- Data written in POST immediately visible in GET
- Offset returned in POST immediately usable in GET

### Offset Generation

Offsets MUST be:
- Unique (no duplicates)
- Monotonically increasing
- Lexicographically sortable

**Safe Implementations:**
- ULID (time + random)
- Snowflake ID
- `${timestamp}_${sequence}`

**Unsafe Implementations:**
- Raw UTC timestamps (can duplicate)
- Sequential integers without padding (wrong sort order)
- Random strings (not monotonic)

### Long-Poll Timeout

Implementation-defined, typically:
- Default: 30 seconds
- Range: 15-60 seconds
- MAY be configurable per request

### Chunk Size

Server MAY limit response size and return partial data:
- Set `Stream-Next-Offset` to position after returned data
- Do NOT set `Stream-Up-To-Date` (more data exists)
- Client continues with pagination

### SSE Connection Lifetime

Servers SHOULD close SSE connections roughly every 60 seconds to enable:
- CDN request collapsing
- Load balancing
- Connection cleanup

## CORS Support

For browser clients, servers SHOULD support CORS:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, HEAD, OPTIONS
Access-Control-Allow-Headers: content-type, authorization, Stream-Seq, Stream-TTL, Stream-Expires-At
Access-Control-Expose-Headers: Stream-Next-Offset, Stream-Cursor, Stream-Up-To-Date, etag, content-type, content-encoding, vary
```

Handle preflight:
```http
OPTIONS {stream-url}

→ 204 No Content
(with CORS headers)
```

## Default Port

Standalone servers SHOULD use port **4437/tcp** as default when no explicit port is configured.

## Security Considerations

### Authentication

Authentication and authorization are out of scope for this specification. Implementations SHOULD support standard HTTP authentication mechanisms.

### Path Validation

Servers MUST validate stream URLs to prevent:
- Path traversal attacks (`../`, `..%2F`)
- URL injection
- Resource exhaustion via deeply nested paths

### Rate Limiting

Servers SHOULD implement rate limiting and return:
```http
429 Too Many Requests
Retry-After: 60
```

### Content Validation

- Validate Content-Type matches stream
- Validate JSON syntax for JSON streams
- Reject malformed offsets
- Sanitize header values

### TLS

All operations MUST use HTTPS (TLS) in production.

## Conformance Checklist

A compliant implementation MUST:

- [ ] Support PUT to create streams
- [ ] Support idempotent PUT with matching config
- [ ] Return 409 for conflicting config
- [ ] Support POST to append data
- [ ] Reject empty POST bodies
- [ ] Validate Content-Type matches stream
- [ ] Support Stream-Seq for coordination
- [ ] Support GET for catch-up reads
- [ ] Support `-1` offset sentinel
- [ ] Return Stream-Next-Offset on all responses
- [ ] Set Stream-Up-To-Date when caught up
- [ ] Generate ETags for cache validation
- [ ] Support If-None-Match for 304 responses
- [ ] Support long-poll mode with `live=long-poll`
- [ ] Require offset for live modes
- [ ] Generate Stream-Cursor on live responses
- [ ] Ensure monotonic cursor progression
- [ ] Support SSE mode for text/* and application/json
- [ ] Return text/event-stream for SSE
- [ ] Send data and control events in SSE
- [ ] Support HEAD for metadata
- [ ] Support DELETE to remove streams
- [ ] Isolate recreated streams after delete
- [ ] Handle JSON mode with array flattening
- [ ] Reject empty JSON arrays in POST
- [ ] Preserve message boundaries in JSON mode
- [ ] Generate unique, monotonic offsets
- [ ] Compare offsets lexicographically
- [ ] Validate offset format
- [ ] Reject malformed offsets
- [ ] Support gzip/deflate compression
- [ ] Validate Stream-TTL format
- [ ] Reject both TTL and Expires-At
- [ ] Ensure read-your-writes consistency
- [ ] Preserve binary data integrity

## References

- **Protocol Specification**: PROTOCOL.md in durable-streams repository
- **Reference Implementation**: packages/server/src/ in durable-streams repository
- **Conformance Tests**: packages/conformance-tests/src/ in durable-streams repository
- **SSE Specification**: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
- **RFC 3339**: Date and Time on the Internet: Timestamps
- **RFC 9110**: HTTP Semantics
