#!/usr/bin/env node
/**
 * Build the Premiere Pro Full MCP UXP bridge as a .ccx package.
 *
 * A .ccx is a ZIP archive whose root *is* the plugin directory (manifest.json
 * sits at the top level, not inside a wrapping folder). This script reads
 * uxp-plugin/ and writes premiere-pro-full-mcp-<version>.ccx using a small
 * dependency-free ZIP writer (Node's zlib provides DEFLATE; we build the local
 * file headers, central directory, and end-of-central-directory records by
 * hand so the package is deterministic and never needs archiver/7zip).
 *
 * Usage:
 *   node scripts/build-ccx.mjs               # uses uxp-plugin/, version from manifest
 *   node scripts/build-ccx.mjs --version 1.1.0
 *   node scripts/build-ccx.mjs --source uxp-plugin --out dist
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArgs(argv) {
  const out = { source: join(ROOT, "uxp-plugin"), out: join(ROOT, "dist"), version: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") out.source = resolve(ROOT, argv[++i]);
    else if (arg === "--out") out.out = resolve(ROOT, argv[++i]);
    else if (arg === "--version") out.version = argv[++i];
    else if (arg === "--help") { console.log("node scripts/build-ccx.mjs [--source DIR] [--out DIR] [--version X.Y.Z]"); process.exit(0); }
  }
  return out;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const dateBits = (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, date: dateBits };
}

function listFiles(dir, base) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(base, full).replace(/\\/g, "/");
    if (statSync(full).isDirectory()) entries.push(...listFiles(full, base));
    else entries.push({ rel, full });
  }
  return entries;
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  const { time, date } = dosDateTime();
  let offset = 0;
  for (const { rel, full } of files) {
    const data = readFileSync(full);
    const nameBuffer = Buffer.from(rel, "utf8");
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);          // local file header signature
    local.writeUInt16LE(20, 4);                  // version needed to extract
    local.writeUInt16LE(0x0800, 6);              // flags: UTF-8 names
    local.writeUInt16LE(8, 8);                   // method: DEFLATE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);                  // extra length
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);        // central directory signature
    central.writeUInt16LE(20, 4);                // version made by
    central.writeUInt16LE(20, 6);                // version needed to extract
    central.writeUInt16LE(0x0800, 8);            // flags
    central.writeUInt16LE(8, 10);                // method
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);                // extra length
    central.writeUInt16LE(0, 32);                // comment length
    central.writeUInt16LE(0, 34);                // disk number start
    central.writeUInt16LE(0, 36);                // internal attributes
    central.writeUInt32LE(0, 38);                // external attributes
    central.writeUInt32LE(offset, 42);           // local header offset
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralLength = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);              // end of central directory signature
  end.writeUInt16LE(0, 4);                       // disk number
  end.writeUInt16LE(0, 6);                       // disk with central dir
  end.writeUInt16LE(files.length, 8);            // entries on disk
  end.writeUInt16LE(files.length, 10);           // total entries
  end.writeUInt32LE(centralLength, 12);
  end.writeUInt32LE(offset, 16);                 // central dir offset
  end.writeUInt16LE(0, 20);                      // comment length
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(join(opts.source, "manifest.json"))) {
    console.error(`[build-ccx] manifest.json not found under ${opts.source}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(join(opts.source, "manifest.json"), "utf8"));
  const version = opts.version ?? manifest.version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(version))) {
    console.error(`[build-ccx] invalid version ${version}`);
    process.exit(1);
  }
  const files = listFiles(opts.source, opts.source);
  if (files.length === 0) {
    console.error("[build-ccx] no files in plugin source");
    process.exit(1);
  }
  const zip = buildZip(files);
  mkdirSync(opts.out, { recursive: true });
  const outPath = join(opts.out, `premiere-pro-full-mcp-${version}.ccx`);
  writeFileSync(outPath, zip);
  console.log(`[build-ccx] wrote ${outPath} (${files.length} files, ${zip.length} bytes)`);
}

main();
