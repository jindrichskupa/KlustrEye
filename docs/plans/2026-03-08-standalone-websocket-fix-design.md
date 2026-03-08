# Design: Standalone WebSocket Integration Fix

**Date:** 2026-03-08
**Status:** Approved
**Author:** Claude + User

## Problem Statement

The Tauri production build fails with "neverending loading" or "500 Internal Server Error" because:

1. `next.config.mjs` uses `output: "standalone"` for efficient bundling
2. `server.ts` uses `next({ dev, hostname, port })` API which is **incompatible** with standalone mode
3. Standalone mode requires using the pre-generated `server.js` that Next.js creates

The standalone `server.js` works correctly when run directly, but our custom server approach for WebSocket support doesn't.

## Solution: Patch Standalone server.js (Approach A)

Modify `pack-server.mjs` to generate a patched `server.js` that:
1. Uses Next.js `startServer()` from standalone (works correctly)
2. Adds WebSocket handlers for terminal/shell after server starts
3. Initializes database and cleans up stale sessions

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Build Process                          │
├─────────────────────────────────────────────────────────────┤
│  npm run build          →  .next/standalone/server.js       │
│  pack-server.mjs        →  Patches server.js + creates tarball│
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Runtime (Tauri)                          │
├─────────────────────────────────────────────────────────────┤
│  node server.js                                             │
│    ├── startServer() → HTTP server (Next.js)                │
│    ├── WebSocketServer (noServer: true)                     │
│    │     ├── /ws/terminal/:ctx/:ns/:pod/:container          │
│    │     └── /ws/shell/:contextName                         │
│    ├── ensureDatabase() → SQLite init                       │
│    └── markStaleSessionsStopped() → cleanup                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                 Runtime (Development)                       │
├─────────────────────────────────────────────────────────────┤
│  npm run dev  →  tsx server.ts  (unchanged)                 │
└─────────────────────────────────────────────────────────────┘
```

**Key points:**
- Development workflow remains unchanged (`server.ts`)
- Production build uses patched standalone `server.js`
- Remove `server.bundle.mjs` from build process (not needed)

## Components and File Changes

### Files to Modify

| File | Change |
|------|--------|
| `scripts/pack-server.mjs` | Main change - generates patched server.js instead of copying server.bundle.mjs |
| `src-tauri/src/lib.rs` | Change `server.bundle.mjs` → `server.js` |
| `package.json` | Remove `server:bundle` from `tauri:prebuild` |

### Files Unchanged

- `server.ts` - development server remains
- `next.config.mjs` - standalone remains
- WebSocket handlers (`src/lib/ws/*`) - remain, will be bundled inline

### New pack-server.mjs Structure

```javascript
// 1. Copy standalone output (as before)
// 2. Instead of copying server.bundle.mjs:
//    - Read .next/standalone/server.js
//    - Extract nextConfig JSON
//    - Generate new server.js with:
//      - WebSocket setup (ws imports, handlers)
//      - Database init (ensureDatabase)
//      - Cleanup (markStaleSessionsStopped)
//      - startServer() with WebSocket upgrade handler
// 3. Continue with node-bin and tarball creation
```

## Data Flow and WebSocket Integration

### Startup Sequence

```
1. node server.js
   │
2. ensureDatabase()           ← SQLite tables exist
   │
3. markStaleSessionsStopped() ← Cleanup old sessions
   │
4. startServer({...})         ← Next.js HTTP server
   │
5. server.on('upgrade', ...)  ← Add WebSocket handler
   │
6. Ready on http://localhost:PORT
```

### WebSocket Upgrade Handling

```javascript
// After startServer() returns { server }:
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = parse(req.url, true);

  if (pathname?.startsWith('/ws/shell/')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      // handleShellConnection(ws, { contextName })
    });
  } else if (pathname?.startsWith('/ws/terminal/')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      // handleTerminalConnection(ws, { contextName, namespace, pod, container })
    });
  } else {
    socket.destroy();
  }
});
```

### Shutdown Handling

```javascript
const shutdown = async () => {
  await cleanupAllPortForwards();
  server.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

## Error Handling

### Build-time Errors (pack-server.mjs)

| Situation | Solution |
|-----------|----------|
| `.next/standalone` doesn't exist | Exit with error "Run 'npm run build' first" |
| Cannot parse nextConfig from server.js | Exit with error, show regex mismatch |
| WebSocket handler files missing | Exit with error, list missing files |

### Runtime Errors (server.js)

| Situation | Solution |
|-----------|----------|
| `ensureDatabase()` fails | Log error, continue (non-fatal) |
| `startServer()` fails | Log error, exit(1) |
| WebSocket upgrade on unknown path | `socket.destroy()` |
| Port already in use | Next.js handled (exit with error) |

### Graceful Shutdown

- SIGTERM/SIGINT → `cleanupAllPortForwards()` → `server.close()` → `exit(0)`
- Cleanup timeout: 5 seconds, then force exit

### Next.js Update Compatibility

- Patch relies on standalone `server.js` structure
- Regex for extracting `nextConfig` should be robust
- If Next.js changes, build fails explicitly (not silently)

## Testing Strategy

### Manual Tests (Critical)

| Test | Steps | Expected Result |
|------|-------|-----------------|
| Build | `npm run tauri:prebuild` | Creates `dist-server/server-pack.tar.gz` without errors |
| Standalone server | Extract tarball, `node server.js` | Server runs, returns HTTP 200 on `/` |
| WebSocket terminal | Open terminal in UI | Connection works, commands execute |
| WebSocket shell | Open shell in UI | kubectl context works |
| Database | After server restart | Data (organizations, settings) persists |
| Tauri app | `npm run tauri:build`, run .dmg | App starts, UI works |
| Dev mode | `npm run dev` | Development server works as before |

### Smoke Test Script (Optional)

```bash
# Quick test after build
cd dist-server/staging
PORT=3333 DATABASE_URL="file:./test.db" node server.js &
sleep 5
curl -s http://localhost:3333/ | grep -q "KlustrEye" && echo "✓ HTTP OK"
pkill -f "node server.js"
```

## Implementation Notes

- The patched `server.js` will inline the WebSocket handler logic (not import from external files) to avoid module resolution issues in the bundled environment
- Database and port-forward cleanup functions will also be inlined
- The `nextConfig` JSON blob from the original server.js will be preserved exactly
