#!/usr/bin/env node
/**
 * Packages the Next.js standalone output + server bundle + Node.js binary
 * into a tarball for Tauri to bundle as a single resource file.
 *
 * The resulting app is fully standalone — no system Node.js required.
 */
import { execSync } from "child_process";
import { mkdirSync, cpSync, existsSync, statSync, chmodSync } from "fs";
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

// Clean and create staging directory
execSync(`rm -rf ${dist}`);
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

// Copy our custom server bundle
cpSync(join(root, "server.bundle.mjs"), join(staging, "server.bundle.mjs"));

// Copy prisma schema
const prismaSchema = join(root, "prisma", "schema.prisma");
if (existsSync(prismaSchema)) {
  mkdirSync(join(staging, "prisma"), { recursive: true });
  cpSync(prismaSchema, join(staging, "prisma", "schema.prisma"));
}

// Overlay full versions of packages that server.bundle.mjs imports directly.
const serverDeps = ["next", "ws", "node-pty"];
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

// Download and bundle Node.js binary
await downloadNodeBinary();

// Create tarball
execSync(`tar -czf server-pack.tar.gz -C staging .`, { cwd: dist });

const size = statSync(join(dist, "server-pack.tar.gz")).size;
console.log(`✓ Created dist-server/server-pack.tar.gz (${(size / 1024 / 1024).toFixed(1)} MB)`);
