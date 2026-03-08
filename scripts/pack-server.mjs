#!/usr/bin/env node
/**
 * Packages the Next.js standalone output + server bundle + Node.js binary
 * into a tarball for Tauri to bundle as a single resource file.
 *
 * The resulting app is fully standalone — no system Node.js required.
 */
import { execSync } from "child_process";
import { mkdirSync, cpSync, existsSync, statSync, chmodSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";

const root = process.cwd();
const dist = join(root, "dist-server");
const staging = join(dist, "staging");

// Detect target platform and arch (can be overridden via env for cross-compilation)
const platform = process.env.TARGET_PLATFORM || process.platform;
const arch = process.env.TARGET_ARCH || process.arch;

// Node.js version to bundle
const NODE_VERSION = process.versions.node.split(".")[0]; // Use same major version

/**
 * Download the Node.js binary for the target platform.
 * Returns the path to the node executable.
 */
async function downloadNodeBinary() {
  const nodeDir = join(dist, "node-download");
  const nodeBinDst = join(staging, "node-bin");
  mkdirSync(nodeBinDst, { recursive: true });

  // Map platform/arch to Node.js download naming
  const platformMap = { darwin: "darwin", linux: "linux", win32: "win" };
  const archMap = { x64: "x64", arm64: "arm64" };
  const plat = platformMap[platform];
  const ar = archMap[arch];
  const isWindows = platform === "win32";

  if (!plat || !ar) {
    console.error(`ERROR: Unsupported platform/arch: ${platform}/${arch}`);
    process.exit(1);
  }

  // Find the actual latest version for this major
  console.log(`  Fetching latest Node.js v${NODE_VERSION}.x listing...`);
  const listUrl = `https://nodejs.org/dist/latest-v${NODE_VERSION}.x/`;
  const listRes = await fetch(listUrl);
  const listHtml = await listRes.text();

  // Windows uses .zip, others use .tar.gz
  const ext = isWindows ? "zip" : "tar.gz";
  const versionRegex = new RegExp(`node-(v${NODE_VERSION}\\.\\d+\\.\\d+)-${plat}-${ar}\\.${ext.replace(".", "\\.")}`);
  const versionMatch = listHtml.match(versionRegex);
  if (!versionMatch) {
    console.error(`ERROR: Could not find Node.js v${NODE_VERSION}.x binary for ${plat}-${ar}`);
    process.exit(1);
  }

  const actualVersion = versionMatch[1];
  const actualDirName = `node-${actualVersion}-${plat}-${ar}`;
  const actualFileName = `${actualDirName}.${ext}`;
  const downloadUrl = `${listUrl}${actualFileName}`;
  const downloadPath = join(dist, actualFileName);

  if (!existsSync(downloadPath)) {
    console.log(`  Downloading Node.js ${actualVersion} for ${plat}-${ar}...`);
    mkdirSync(dist, { recursive: true });
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      console.error(`ERROR: Failed to download ${downloadUrl}: ${res.status}`);
      process.exit(1);
    }
    await pipeline(res.body, createWriteStream(downloadPath));
    console.log(`  Downloaded ${actualFileName}`);
  }

  mkdirSync(nodeDir, { recursive: true });
  console.log(`  Extracting node binary...`);

  if (isWindows) {
    // Windows: extract node.exe from zip using PowerShell
    const zipEntry = `${actualDirName}/node.exe`;
    execSync(
      `powershell -Command "Expand-Archive -Path '${downloadPath}' -DestinationPath '${nodeDir}' -Force"`,
      { stdio: "pipe" }
    );
    const nodeSrc = join(nodeDir, actualDirName, "node.exe");
    const nodeDst = join(nodeBinDst, "node.exe");
    cpSync(nodeSrc, nodeDst);
    console.log(`  Bundled Node.js ${actualVersion} (${plat}-${ar})`);
  } else {
    // macOS/Linux: extract node binary from tar.gz
    execSync(`tar -xzf "${downloadPath}" -C "${nodeDir}" "${actualDirName}/bin/node"`, { stdio: "pipe" });
    const nodeSrc = join(nodeDir, actualDirName, "bin", "node");
    const nodeDst = join(nodeBinDst, "node");
    cpSync(nodeSrc, nodeDst);
    chmodSync(nodeDst, 0o755);
    console.log(`  Bundled Node.js ${actualVersion} (${plat}-${ar})`);
  }
}

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
async function getKubeConfig(contextName) {
  const k8s = await import('@kubernetes/client-node');
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
  return { kc, k8s };
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
      const { kc, k8s } = await getKubeConfig(contextName);
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
import http from 'node:http';

const { WebSocketServer } = require('ws');

// Monkey-patch http.createServer to capture the server instance
let capturedServer = null;
const originalCreateServer = http.createServer;
http.createServer = function(...args) {
  capturedServer = originalCreateServer.apply(this, args);
  return capturedServer;
};

require('next');
const { startServer } = require('next/dist/server/lib/start-server');

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

  // Start Next.js server (this will use our patched createServer)
  await startServer({
    dir,
    isDev: false,
    config: nextConfig,
    hostname,
    port: currentPort,
    allowRetry: false,
    keepAliveTimeout,
  });

  // Get the captured HTTP server
  const server = capturedServer;
  if (!server) {
    console.error("ERROR: Could not capture HTTP server from Next.js");
    process.exit(1);
  }

  // Create WebSocket server (noServer mode - we handle upgrades ourselves)
  const wss = new WebSocketServer({ noServer: true });

  // Prepend our WebSocket upgrade handler before Next.js handlers
  const existingListeners = server.listeners('upgrade');
  server.removeAllListeners('upgrade');

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

    // Not our WebSocket route - pass to Next.js handlers
    for (const listener of existingListeners) {
      listener.call(server, req, socket, head);
    }
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

// Clean and create staging directory
rmSync(dist, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// Use the standalone output as the root (it contains .next/ and node_modules/)
const standalone = join(root, ".next", "standalone");
if (!existsSync(standalone)) {
  console.error("ERROR: .next/standalone not found. Run 'npm run build' first.");
  process.exit(1);
}
cpSync(standalone, staging, { recursive: true });

// Copy static assets into .next/static/ (not included in standalone output)
const staticDir = join(root, ".next", "static");
if (existsSync(staticDir)) {
  cpSync(staticDir, join(staging, ".next", "static"), { recursive: true });
}

// Copy public directory into the root
const publicDir = join(root, "public");
if (existsSync(publicDir)) {
  cpSync(publicDir, join(staging, "public"), { recursive: true });
}

// Generate patched server.js with WebSocket support
const standaloneServer = join(standalone, "server.js");
generatePatchedServer(standaloneServer, join(staging, "server.js"));

// Copy prisma schema
const prismaSchema = join(root, "prisma", "schema.prisma");
if (existsSync(prismaSchema)) {
  mkdirSync(join(staging, "prisma"), { recursive: true });
  cpSync(prismaSchema, join(staging, "prisma", "schema.prisma"));
}

// Overlay full versions of packages that server.bundle.mjs imports directly.
const serverDeps = ["next", "ws", "node-pty", "@prisma/client", "@kubernetes/client-node"];
const srcModules = join(root, "node_modules");
const dstModules = join(staging, "node_modules");

for (const pkg of serverDeps) {
  const src = join(srcModules, pkg);
  if (existsSync(src)) {
    const dst = join(dstModules, pkg);
    cpSync(src, dst, { recursive: true });
    console.log(`  Overlaid node_modules/${pkg}`);
  }
}

// Overlay .prisma generated client (contains the native engine binary)
const dotPrisma = join(srcModules, ".prisma");
if (existsSync(dotPrisma)) {
  cpSync(dotPrisma, join(dstModules, ".prisma"), { recursive: true });
  console.log("  Overlaid node_modules/.prisma");
}

// Turbopack externalizes packages with a content hash suffix
// (e.g. @prisma/client-2c3a283f134fdcb6, @kubernetes/client-node-e91ae5858104584f).
// Scan chunks for these hashed names and create copies pointing to the real package.
const chunksDir = join(staging, ".next", "server", "chunks");
if (existsSync(chunksDir)) {
  // Match scoped (@scope/pkg-HASH) and unscoped (pkg-HASH) patterns
  const hashPattern = /(?:@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_.-]+-[a-f0-9]{16}/g;
  const aliases = new Set();
  for (const f of readdirSync(chunksDir)) {
    if (!f.endsWith(".js")) continue;
    const content = readFileSync(join(chunksDir, f), "utf8");
    for (const m of content.matchAll(hashPattern)) {
      aliases.add(m[0]);
    }
  }
  for (const hashedName of aliases) {
    // Strip the -HASH suffix to get the real package name
    const realName = hashedName.replace(/-[a-f0-9]{16}$/, "");
    const realDir = join(dstModules, ...realName.split("/"));
    const aliasDir = join(dstModules, ...hashedName.split("/"));
    if (existsSync(realDir) && !existsSync(aliasDir)) {
      mkdirSync(join(aliasDir, ".."), { recursive: true });
      cpSync(realDir, aliasDir, { recursive: true });
      console.log(`  Created alias ${hashedName} -> ${realName}`);
    }
  }
}

// Download and bundle Node.js binary
await downloadNodeBinary();

// Create tarball (use platform-appropriate command)
if (platform === "win32") {
  // Windows tar doesn't support -C reliably; use PowerShell to cd first
  execSync(
    `powershell -Command "Push-Location '${staging}'; tar -czf '${join(dist, "server-pack.tar.gz")}' .; Pop-Location"`,
    { stdio: "pipe" }
  );
} else {
  execSync(`tar -czf server-pack.tar.gz -C staging .`, { cwd: dist });
}

const size = statSync(join(dist, "server-pack.tar.gz")).size;
console.log(`✓ Created dist-server/server-pack.tar.gz (${(size / 1024 / 1024).toFixed(1)} MB)`);
