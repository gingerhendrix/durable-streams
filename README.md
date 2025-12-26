# Durable Streams

A Durable Streams protocol implementation for Cloudflare Workers using Durable Objects.

## Architecture

The implementation follows a 3-layer architecture:

1. **HTTP Layer** - Request parsing, response formatting, status codes
2. **Protocol Layer** - Validation, JSON mode, cursor generation, orchestration
3. **Storage Layer** - Persistence with SQLite-backed Durable Objects

## Project Structure

```
packages/
├── server/          - Durable Object implementation
│   ├── src/
│   │   ├── index.ts      - HTTP adapter & DO class
│   │   ├── protocol.ts   - Protocol layer
│   │   └── storage.ts    - Storage layer
│   └── alchemy.resource.ts
└── types/           - Shared TypeScript types
    └── src/
        ├── protocol.ts
        └── storage.ts
```

## Development

This is a Bun workspace monorepo with Alchemy for deployment.

### Install Dependencies

```bash
bun install
```

### Type Check

```bash
bun run typecheck
```

### Deploy

```bash
bun run deploy
```

### Development Mode

```bash
bun run dev
```

### Destroy Deployment

```bash
bun run destroy
```

## Documentation

See `personal-vault/daily/2025-12-24/durable-streams/` for complete architecture documentation:

- `overview.md` - Architecture overview
- `http-spec.md` - Complete HTTP API specification
- `types.md` - TypeScript type definitions
- `protocol.md` - Protocol layer design
- `storage.md` - Storage layer design

## Key Features

- **Durable**: Bytes persist once written and acknowledged
- **Immutable**: Bytes at a given offset never change
- **Ordered**: Strictly ordered by offset
- **Typed**: Each stream has a MIME content type
- **TTL/Expiry**: Optional time-to-live or absolute expiry
- **JSON Mode**: Special handling for JSON streams with array flattening
- **Live Reads**: Long-poll and SSE support for real-time data
- **Sequence Coordination**: Optional monotonic sequence numbers for writers
- **CDN-Friendly**: Cursor mechanism prevents infinite cache loops

## License

MIT
