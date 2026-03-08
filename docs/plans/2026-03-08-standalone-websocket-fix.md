# Standalone WebSocket Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix Tauri production build by patching standalone server.js to include WebSocket support for terminal/shell connections.

**Architecture:** Modify `pack-server.mjs` to generate a patched `server.js` that uses Next.js `startServer()` (which works with standalone mode) and adds WebSocket handlers. The handlers will be inlined to avoid module resolution issues.

**Tech Stack:** Node.js, Next.js standalone, WebSocket (ws), node-pty, @kubernetes/client-node, Prisma

---

## Task 1: Update pack-server.mjs to generate patched server.js

**Files:**
- Modify: `scripts/pack-server.mjs`

**Step 1: Remove server.bundle.mjs copy (line 129)**

Delete this line:
```javascript
// Copy our custom server bundle
cpSync(join(root, "server.bundle.mjs"), join(staging, "server.bundle.mjs"));
```

**Step 2: Add function to generate patched server.js**

Add this function before the "Clean and create staging directory" comment (around line 103):

```javascript
import { writeFileSync } from "fs";

/**
 * Generate a patched server.js that combines Next.js standalone server
 * with WebSocket support for terminal/shell connections.
 */
function generatePatchedServer(standaloneServerPath, outputPath) {
  const originalServer = readFileSync(standaloneServerPath, "utf8");

  // Extract nextConfig JSON from the original server.js
  const configMatch = originalServer.match(/const nextConfig = ({[\s\S]*?})\n\nprocess\.env\.__NEXT_PRIVATE_STANDALONE_CONFIG/);
  if (!configMatch) {
    console.error("ERROR: Could not extract nextConfig from standalone server.js");
    console.error("The Next.js standalone output format may have changed.");
    process.exit(1);
  }
  const nextConfigJson = configMatch[1];

  const patchedServer = `performance.mark('next-start');
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import module from 'node:module';
import { createServer } from 'node:http';
import { parse } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { homedir } from 'node:os';
import { chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';

const require = module.createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const dir = path.join(__dirname);

process.env.NODE_ENV = 'production';
process.chdir(__dirname);

const currentPort = parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || '0.0.0.0';

let keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);
const nextConfig = ${nextConfigJson};

process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

// ============================================================================
// Database initialization (from src/lib/prisma.ts)
// ============================================================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SCHEMA_STATEMENTS = [
  \`CREATE TABLE IF NOT EXISTS "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )\`,
  \`CREATE UNIQUE INDEX IF NOT EXISTS "Organization_name_key" ON "Organization"("name")\`,
  \`CREATE TABLE IF NOT EXISTS "ClusterContext" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contextName" TEXT NOT NULL,
    "displayName" TEXT,
    "lastNamespace" TEXT NOT NULL DEFAULT 'default',
    "pinned" BOOLEAN NOT NULL DEFAULT 0,
    "organizationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClusterContext_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  )\`,
  \`CREATE UNIQUE INDEX IF NOT EXISTS "ClusterContext_contextName_key" ON "ClusterContext"("contextName")\`,
  \`CREATE TABLE IF NOT EXISTS "ClusterSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clusterId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClusterSetting_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "ClusterContext" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )\`,
  \`CREATE UNIQUE INDEX IF NOT EXISTS "ClusterSetting_clusterId_key_key" ON "ClusterSetting"("clusterId", "key")\`,
  \`CREATE TABLE IF NOT EXISTS "UserPreference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL
  )\`,
  \`CREATE UNIQUE INDEX IF NOT EXISTS "UserPreference_key_key" ON "UserPreference"("key")\`,
  \`CREATE TABLE IF NOT EXISTS "SavedTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "yaml" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )\`,
  \`CREATE TABLE IF NOT EXISTS "TerminalSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contextName" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "podName" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )\`,
  \`CREATE TABLE IF NOT EXISTS "PortForwardSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contextName" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceName" TEXT NOT NULL,
    "localPort" INTEGER NOT NULL,
    "remotePort" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "errorMessage" TEXT,
    "pid" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" DATETIME
  )\`,
];

async function ensureDatabase() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      for (const sql of SCHEMA_STATEMENTS) {
        await prisma.$executeRawUnsafe(sql);
      }
      return;
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      } else {
        console.error("ensureDatabase failed:", err);
      }
    }
  }
}

async function markStaleSessionsStopped() {
  try {
    await prisma.portForwardSession.updateMany({
      where: { status: { in: ["active", "starting"] } },
      data: { status: "stopped", stoppedAt: new Date() },
    });
  } catch (err) {
    console.error("markStaleSessionsStopped failed:", err);
  }
}

async function cleanupAllPortForwards() {
  try {
    await prisma.portForwardSession.updateMany({
      where: { status: { in: ["active", "starting"] } },
      data: { status: "stopped", stoppedAt: new Date() },
    });
  } catch (err) {
    console.error("cleanupAllPortForwards failed:", err);
  }
}

// ============================================================================
// Kubernetes client (from src/lib/k8s/client.ts)
// ============================================================================
const k8s = require('@kubernetes/client-node');

function getKubeConfig(contextName) {
  const kc = new k8s.KubeConfig();
  const configPath = process.env.KUBECONFIG_PATH || process.env.KUBECONFIG;
  if (configPath) {
    kc.loadFromFile(configPath);
  } else {
    kc.loadFromDefault();
  }
  if (contextName) {
    kc.setCurrentContext(contextName);
  }
  return kc;
}

// ============================================================================
// Terminal handler (from src/lib/ws/terminal-handler.ts)
// ============================================================================
function handleTerminalConnection(ws, params) {
  const { contextName, namespace, pod, container } = params;
  let closed = false;

  const cleanup = () => { closed = true; };
  ws.on("close", cleanup);
  ws.on("error", cleanup);

  (async () => {
    try {
      const kc = getKubeConfig(contextName);
      const exec = new k8s.Exec(kc);

      const writableStdout = new Writable({
        write(chunk, _encoding, callback) {
          if (!closed && ws.readyState === ws.OPEN) {
            ws.send(chunk.toString());
          }
          callback();
        },
      });

      const writableStderr = new Writable({
        write(chunk, _encoding, callback) {
          if (!closed && ws.readyState === ws.OPEN) {
            ws.send(chunk.toString());
          }
          callback();
        },
      });

      const readableStdin = new Readable({ read() {} });
      const command = ["/bin/sh", "-c", "exec bash || exec sh"];

      const conn = await exec.exec(
        namespace,
        pod,
        container,
        command,
        writableStdout,
        writableStderr,
        readableStdin,
        true
      );

      ws.on("message", (data) => {
        const msg = data.toString();
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === "resize" && conn) return;
        } catch {}
        readableStdin.push(msg);
      });

      ws.on("close", () => {
        readableStdin.push(null);
        if (conn && typeof conn.close === "function") {
          conn.close();
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Terminal connection failed";
      if (ws.readyState === ws.OPEN) {
        ws.send(\`\\r\\nError: \${message}\\r\\n\`);
        ws.close(1011, message);
      }
    }
  })();
}

// ============================================================================
// Shell handler (from src/lib/ws/shell-handler.ts)
// ============================================================================
let pty;
try {
  pty = require('node-pty');
  // Fix spawn-helper permissions
  try {
    const spawnHelper = join(
      require.resolve("node-pty/package.json"),
      "..",
      "prebuilds",
      \`\${process.platform}-\${process.arch}\`,
      "spawn-helper"
    );
    const st = statSync(spawnHelper);
    if (!(st.mode & 0o111)) {
      chmodSync(spawnHelper, st.mode | 0o755);
    }
  } catch {}
} catch (err) {
  console.error("node-pty not available:", err.message);
}

async function resolveKubeconfigPath() {
  try {
    const pref = await prisma.userPreference.findUnique({
      where: { key: "kubeconfigPath" },
    });
    if (pref?.value) return pref.value;
  } catch {}
  if (process.env.KUBECONFIG_PATH) return process.env.KUBECONFIG_PATH;
  return undefined;
}

async function handleShellConnection(ws, params) {
  const { contextName } = params;

  if (!pty) {
    ws.send("\\r\\nError: Shell not available (node-pty not loaded)\\r\\n");
    ws.close(1011, "node-pty not available");
    return;
  }

  const shell = process.env.SHELL || "/bin/bash";
  const home = homedir();
  const kubeconfigPath = await resolveKubeconfigPath();

  const env = { ...process.env };
  if (kubeconfigPath) {
    env.KUBECONFIG = kubeconfigPath;
  }

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: home,
      env,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to spawn shell";
    if (ws.readyState === ws.OPEN) {
      ws.send(\`\\r\\nError: \${message}\\r\\n\`);
      ws.close(1011, message);
    }
    return;
  }

  ptyProcess.write(\`kubectl config use-context \${contextName} 2>/dev/null && clear\\r\`);

  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  ptyProcess.onExit(() => {
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, "Shell exited");
    }
  });

  ws.on("message", (data) => {
    const msg = data.toString();
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === "resize") {
        ptyProcess.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {}
    ptyProcess.write(msg);
  });

  const cleanup = () => {
    try { ptyProcess.kill(); } catch {}
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

// ============================================================================
// Main server startup
// ============================================================================
require('next');
const { startServer } = require('next/dist/server/lib/start-server');
const { WebSocketServer } = require('ws');

if (
  Number.isNaN(keepAliveTimeout) ||
  !Number.isFinite(keepAliveTimeout) ||
  keepAliveTimeout < 0
) {
  keepAliveTimeout = undefined;
}

(async () => {
  // Initialize database
  await ensureDatabase();
  await markStaleSessionsStopped();

  // Start Next.js server
  const serverResult = await startServer({
    dir,
    isDev: false,
    config: nextConfig,
    hostname,
    port: currentPort,
    allowRetry: false,
    keepAliveTimeout,
  });

  // Get the HTTP server from Next.js
  const server = serverResult?.server;
  if (!server) {
    console.error("ERROR: Could not get HTTP server from Next.js startServer");
    process.exit(1);
  }

  // Create WebSocket server (noServer mode - we handle upgrades ourselves)
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrade requests
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url, true);

    if (pathname?.startsWith('/ws/shell/')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length >= 3) {
          const contextName = decodeURIComponent(parts[2]);
          handleShellConnection(ws, { contextName });
        } else {
          ws.close(1008, 'Invalid shell path');
        }
      });
      return;
    }

    if (pathname?.startsWith('/ws/terminal/')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length >= 6) {
          const contextName = decodeURIComponent(parts[2]);
          const namespace = decodeURIComponent(parts[3]);
          const pod = decodeURIComponent(parts[4]);
          const container = decodeURIComponent(parts[5]);
          handleTerminalConnection(ws, { contextName, namespace, pod, container });
        } else {
          ws.close(1008, 'Invalid terminal path');
        }
      });
      return;
    }

    // Not a WebSocket route we handle - destroy the socket
    socket.destroy();
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await cleanupAllPortForwards();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(\`> Ready on http://\${hostname}:\${currentPort}\`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

  writeFileSync(outputPath, patchedServer);
  console.log("  Generated patched server.js with WebSocket support");
}
```

**Step 3: Call generatePatchedServer instead of copying server.bundle.mjs**

After the standalone copy (around line 114), replace the server.bundle.mjs copy with:

```javascript
// Generate patched server.js with WebSocket support
const standaloneServer = join(standalone, "server.js");
generatePatchedServer(standaloneServer, join(staging, "server.js"));
```

**Step 4: Run build to verify**

Run: `npm run build && node scripts/pack-server.mjs`

Expected: Build completes without errors, outputs "Generated patched server.js with WebSocket support"

**Step 5: Commit**

```bash
git add scripts/pack-server.mjs
git commit -m "feat: generate patched server.js with WebSocket support for standalone mode"
```

---

## Task 2: Update Tauri to run server.js instead of server.bundle.mjs

**Files:**
- Modify: `src-tauri/src/lib.rs:140`

**Step 1: Change server entry point**

Change line 140 from:
```rust
let server_bundle = server_dir.join("server.bundle.mjs");
```

To:
```rust
let server_bundle = server_dir.join("server.js");
```

**Step 2: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix: run server.js instead of server.bundle.mjs in Tauri"
```

---

## Task 3: Update package.json to remove server:bundle from tauri:prebuild

**Files:**
- Modify: `package.json:15`

**Step 1: Simplify tauri:prebuild script**

Change line 15 from:
```json
"tauri:prebuild": "npm run build && npm run server:bundle && node scripts/pack-server.mjs",
```

To:
```json
"tauri:prebuild": "npm run build && node scripts/pack-server.mjs",
```

**Step 2: Commit**

```bash
git add package.json
git commit -m "chore: remove server:bundle from tauri:prebuild (no longer needed)"
```

---

## Task 4: Test the fix manually

**Step 1: Build everything**

Run: `npm run tauri:prebuild`

Expected:
- Build completes
- `dist-server/server-pack.tar.gz` created
- Log shows "Generated patched server.js with WebSocket support"

**Step 2: Test standalone server directly**

Run:
```bash
cd dist-server/staging
PORT=3333 DATABASE_URL="file:./test.db" node server.js
```

Expected:
- Server starts without "next start does not work with standalone" warning
- Output: `> Ready on http://0.0.0.0:3333`

**Step 3: Test HTTP response**

Run: `curl -s http://localhost:3333/ | head -5`

Expected: HTML containing "KlustrEye"

**Step 4: Stop test server**

Run: `pkill -f "node server.js"`

---

## Task 5: Build and test Tauri app

**Step 1: Build Tauri app**

Run: `npm run tauri:build`

Expected: Build completes, creates `.dmg` in `src-tauri/target/release/bundle/macos/`

**Step 2: Install and run the app**

1. Open the `.dmg` file
2. Drag KlustrEye to Applications (or run directly)
3. Launch KlustrEye

Expected:
- App opens without white screen or 500 error
- Homepage shows cluster list
- Terminal/shell connections work (test by opening a pod terminal)

**Step 3: Commit all changes together**

If not already committed:
```bash
git add -A
git commit -m "fix: resolve standalone mode WebSocket incompatibility

- Generate patched server.js that uses Next.js startServer() with WebSocket support
- Inline terminal/shell handlers to avoid module resolution issues
- Update Tauri to run server.js instead of server.bundle.mjs
- Remove server:bundle step from build process

Fixes production build showing 'neverending loading' or 500 errors."
```

---

## Summary

| Task | Files | Description |
|------|-------|-------------|
| 1 | `scripts/pack-server.mjs` | Generate patched server.js with WebSocket |
| 2 | `src-tauri/src/lib.rs` | Change entry point to server.js |
| 3 | `package.json` | Remove server:bundle from prebuild |
| 4 | - | Manual testing of standalone server |
| 5 | - | Build and test Tauri app |
