import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 48 * 1024;
const DENIED_SEGMENTS = new Set([
  ".git", ".codex", ".aws", ".ssh", ".gnupg", ".venv", ".cache", ".mypy_cache",
  ".nox", ".pytest_cache", ".ruff_cache", ".tox", "__pycache__", "artifacts",
  "coverage", "dist", "generated", "node_modules", "out", "target", "vendor",
]);

export class RepositoryReadError extends Error {
  constructor(code) { super(code); this.name = "RepositoryReadError"; this.code = code; }
}
const reject = (code = "broker-invalid-request") => { throw new RepositoryReadError(code); };

export function readableRepositoryPath(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 1024 || /[\\:\x00-\x1f\x7f]/.test(value) ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || DENIED_SEGMENTS.has(part.toLowerCase()))) return false;
  const basename = parts.at(-1).toLowerCase();
  return !/^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|auth\.json|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/.test(basename) &&
    !/\.(?:pem|key|p12|pfx|jks|keystore)$/.test(basename);
}

function equalPath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function argsObject(args, allowed) {
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).some((key) => !allowed.includes(key))) reject();
}
function integer(value, fallback, minimum, maximum) {
  const actual = value === undefined ? fallback : value;
  if (!Number.isInteger(actual) || actual < minimum || actual > maximum) reject();
  return actual;
}
function text(value, fallback, maximum) {
  const actual = value === undefined ? fallback : value;
  if (typeof actual !== "string" || Buffer.byteLength(actual) > maximum || actual.includes("\0")) reject();
  return actual;
}

export async function createRepositoryReader({ repo, snapshot }) {
  const root = await fs.realpath(repo);
  const rootIdentity = await fs.lstat(root);
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) reject("broker-path-denied");
  let paths = [...snapshot.paths].filter((relative) => {
    const entry = snapshot.entries.get(relative);
    return readableRepositoryPath(relative) && entry?.kind === "file" && entry.bytes <= MAX_FILE_BYTES;
  }).sort();
  const ignored = new Set();
  for (let offset = 0; offset < paths.length; offset += 500) {
    const outcome = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-z", "--stdin"], {
      input: `${paths.slice(offset, offset + 500).join("\0")}\0`, encoding: "utf8",
      timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    if (outcome.error || ![0, 1].includes(outcome.status)) reject("broker-inventory-unavailable");
    for (const relative of outcome.stdout.split("\0")) if (relative) ignored.add(relative);
  }
  paths = paths.filter((relative) => !ignored.has(relative));
  const allowed = new Set(paths);

  async function checkRoot() {
    const current = await fs.lstat(root);
    if (current.isSymbolicLink() || !sameFile(rootIdentity, current) || !equalPath(await fs.realpath(root), root)) {
      reject("broker-path-denied");
    }
  }
  async function checkPath(relative) {
    if (!readableRepositoryPath(relative) || !allowed.has(relative)) reject("broker-path-denied");
    await checkRoot();
    let full = root;
    let info;
    for (const component of relative.split("/")) {
      full = path.join(full, component);
      info = await fs.lstat(full);
      if (info.isSymbolicLink()) reject("broker-path-denied");
    }
    if (!info.isFile() || info.nlink !== 1 || !equalPath(await fs.realpath(full), full)) reject("broker-path-denied");
    return { full, info };
  }
  async function read(relative) {
    const { full, info } = await checkPath(relative);
    const entry = snapshot.entries.get(relative);
    if (info.size !== entry.bytes || info.size > MAX_FILE_BYTES) reject("broker-repository-changed");
    const handle = await fs.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !sameFile(info, opened)) reject("broker-path-denied");
      const buffer = Buffer.alloc(entry.bytes + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      const bytes = buffer.subarray(0, used);
      const digest = createHash("sha256").update("rg-worktree-entry-file-v1\0").update(bytes).digest("hex");
      if (used !== entry.bytes || digest !== entry.digest) reject("broker-repository-changed");
      const after = await checkPath(relative);
      if (!sameFile(opened, after.info)) reject("broker-path-denied");
      let contents;
      try { contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { reject("broker-non-text-file"); }
      if (contents.includes("\0") || /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----/.test(contents)) reject("broker-path-denied");
      return contents;
    } finally { await handle.close(); }
  }

  async function perform(name, args) {
    await checkRoot();
    if (name === "list_files") {
      argsObject(args, ["contains", "cursor", "limit"]);
      const contains = text(args.contains, "", 256);
      const cursor = integer(args.cursor, 0, 0, paths.length);
      const limit = integer(args.limit, 100, 1, 100);
      const selected = [];
      let index = cursor;
      for (; index < paths.length && selected.length < limit; index++) {
        if (paths[index].includes(contains)) selected.push(paths[index]);
      }
      return { paths: selected, next_cursor: index < paths.length ? index : null };
    }
    if (name === "read_lines") {
      argsObject(args, ["path", "line_start", "line_end"]);
      const start = integer(args.line_start, 1, 1, 10_000_000);
      const end = integer(args.line_end, start + 79, start, start + 199);
      const contents = await read(args.path);
      const lines = contents.split(/\r?\n/);
      if (lines.at(-1) === "" && lines.length > 1) lines.pop();
      if (start > lines.length) reject("broker-invalid-range");
      return { path: args.path, line_start: start, line_end: Math.min(end, lines.length), text: lines.slice(start - 1, end).join("\n") };
    }
    if (name === "search") {
      argsObject(args, ["query", "path", "cursor", "limit"]);
      const query = text(args.query, "", 256);
      if (!query) reject();
      const limit = integer(args.limit, 30, 1, 100);
      if (args.path !== undefined && (!readableRepositoryPath(args.path) || !allowed.has(args.path))) reject("broker-path-denied");
      const candidates = args.path === undefined ? paths : [args.path];
      let index = integer(args.cursor, 0, 0, candidates.length);
      const matches = [];
      let bytes = 0, scanned = 0, matchesTruncated = false;
      const deadline = Date.now() + 5000;
      for (; index < candidates.length; index++) {
        const relative = candidates[index];
        if (Date.now() > deadline || scanned >= 1000 || bytes + snapshot.entries.get(relative).bytes > 16 * 1024 * 1024) break;
        scanned++;
        bytes += snapshot.entries.get(relative).bytes;
        let contents;
        try { contents = await read(relative); }
        catch (error) {
          if (["broker-non-text-file", "broker-path-denied"].includes(error.code)) continue;
          throw error;
        }
        const lines = contents.split(/\r?\n/);
        for (let line = 0; line < lines.length; line++) {
          if (lines[line].includes(query)) {
            if (matches.length === limit) { matchesTruncated = true; break; }
            matches.push({ path: relative, line: line + 1, text: lines[line].slice(0, 300) });
          }
        }
        if (matches.length >= limit) { index++; break; }
      }
      return { matches, scanned_files: scanned, truncated: matchesTruncated || index < candidates.length,
        next_cursor: index < candidates.length ? index : null, matches_truncated_in_last_file: matchesTruncated };
    }
    reject();
  }

  return {
    paths: Object.freeze([...paths]),
    async call(name, args = {}) {
      try {
        const result = { ...(await perform(name, args)), fingerprint_digest: snapshot.public.digest };
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) reject("broker-output-limit");
        return result;
      } catch (error) {
        if (error instanceof RepositoryReadError) throw error;
        reject("broker-read-unavailable");
      }
    },
  };
}
