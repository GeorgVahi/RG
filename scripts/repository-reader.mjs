import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { runBounded } from "./bounded-process.mjs";
import { openRepository, safeRelative } from "./repository-fs.mjs";
import { isCatalog, assertCurrentIgnorePolicy } from "./catalog.mjs";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 48 * 1024;
const DENIED_SEGMENTS = new Set([
  ".git", ".codex", ".aws", ".ssh", ".gnupg", ".venv", ".cache", ".mypy_cache",
  ".nox", ".pytest_cache", ".ruff_cache", ".tox", "__pycache__", "artifacts",
  "coverage", "dist", "generated", "node_modules", "out", "target", "vendor",
]);

export class RepositoryReadError extends Error {
  constructor(code, bytes = 0) { super(code); this.name = "RepositoryReadError"; this.code = code; this.bytes = bytes; }
}
const reject = (code = "broker-invalid-request", bytes = 0) => { throw new RepositoryReadError(code, bytes); };

export function readableRepositoryPath(value) {
  if (!safeRelative(value) || Buffer.byteLength(value) > 1024 || /[\\:\x00-\x1f\x7f]/.test(value) ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || DENIED_SEGMENTS.has(part.toLowerCase()))) return false;
  const basename = parts.at(-1).toLowerCase();
  return !/^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|auth\.json|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/.test(basename) &&
    !/\.(?:pem|key|p12|pfx|jks|keystore)$/.test(basename);
}

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

export async function createRepositoryReader({ repo, snapshot, signal, onObservation = async () => {} }) {
  const repository = await openRepository(repo, snapshot.rootIdentity);
  const live = isCatalog(snapshot), observed = new Map();
  const root = repository.root;
  const ignored = new Set(snapshot.ignored ?? []);
  if (!snapshot.ignored) {
    const all = [...snapshot.paths];
    for (let offset = 0; offset < all.length; offset += 500) {
      const outcome = await runBounded("git", ["--no-optional-locks", "-C", root, "check-ignore", "--no-index", "-z", "--stdin"], {
        input: all.slice(offset, offset + 500).join("\0") + "\0", timeoutMs: 5000, signal, maxBuffer: 1024 * 1024, prefix: "broker-inventory" });
      if (![0, 1].includes(outcome.status)) reject("broker-inventory-unavailable");
      for (const relative of outcome.stdout.toString("utf8").split("\0")) if (relative) ignored.add(relative);
    }
  }
  const exclusions = {};
  const paths = [...snapshot.paths].filter((relative) => {
    const entry = snapshot.entries.get(relative);
    const reason = !readableRepositoryPath(relative) ? "path-policy" : ignored.has(relative) ? "gitignored"
      : entry?.kind !== "file" && !(live && entry?.kind === "candidate") ? entry?.kind ?? "unavailable" : entry.bytes > MAX_FILE_BYTES ? "large-file" : null;
    if (reason) { exclusions[reason] = (exclusions[reason] ?? 0) + 1; return false; }
    return true;
  }).sort();
  const allowed = new Set(paths), secret = randomBytes(32);
  const excluded = Object.values(exclusions).reduce((a, b) => a + b, 0);
  const binding = (name, args) => createHash("sha256").update(JSON.stringify([snapshot.public.digest, name, args])).digest("hex");
  function cursorEncode(bind, position) {
    const payload = Buffer.from(JSON.stringify({ v: 2, binding: bind, ...position })).toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
  }
  function cursorDecode(value, bind, maximum) {
    if (value === undefined || value === 0) return { index: 0, line: 0, column: 0 };
    if (typeof value !== "string" || value.length > 1024) reject("broker-invalid-cursor");
    const [payload, signature, extra] = value.split(".");
    if (extra || signature !== createHmac("sha256", secret).update(payload).digest("hex")) reject("broker-invalid-cursor");
    let cursor;
    try { cursor = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { reject("broker-invalid-cursor"); }
    if (cursor.v !== 2 || cursor.binding !== bind || !Number.isInteger(cursor.index) || cursor.index < 0 || cursor.index > maximum ||
        !Number.isInteger(cursor.line) || cursor.line < 0 || !Number.isInteger(cursor.column) || cursor.column < 0) reject("broker-invalid-cursor");
    return cursor;
  }
  const linesOf = (contents) => {
    const lines = contents.split(/\r?\n/);
    if (lines.at(-1) === "" && lines.length > 1) lines.pop();
    return lines;
  };
  async function read(relative, callSignal, remainingBytes = Infinity) {
    if (!readableRepositoryPath(relative) || !allowed.has(relative)) reject("broker-path-denied");
    let inspection;
    if (live) {
      inspection = await repository.inspect(relative);
      if (inspection.info.size > remainingBytes && inspection.info.size <= MAX_FILE_BYTES) reject("broker-scan-budget");
      await assertCurrentIgnorePolicy(root, relative, { signal: callSignal ?? signal });
    }
    const measured = await repository.read(relative, { collect: true, maximumBytes: MAX_FILE_BYTES,
      expected: live ? undefined : snapshot.entries.get(relative), inspection, signal: callSignal ?? signal });
    let contents;
    try { contents = new TextDecoder("utf-8", { fatal: true }).decode(measured.contents); }
    catch { reject("broker-non-text-file", measured.bytes); }
    if (contents.includes("\0")) reject("broker-non-text-file", measured.bytes);
    if (/^[ \t]*-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----[ \t]*\r?$/m.test(contents)) reject("broker-content-denied", measured.bytes);
    if (live) {
      const previous = observed.get(relative);
      if (!previous || previous.digest !== measured.digest) await onObservation(relative, measured);
      if (previous && previous.digest !== measured.digest) reject("broker-repository-changed", measured.bytes);
      observed.set(relative, { kind: "file", bytes: measured.bytes, lines: measured.lines, digest: measured.digest });
    }
    return contents;
  }
  function publicCode(error) {
    if (error instanceof RepositoryReadError) return error.code;
    if (["broker-path-denied", "broker-policy-unavailable", "broker-policy-timeout"].includes(error.code)) return error.code;
    if (["repository-path-denied", "repository-linked-path", "repository-root-changed"].includes(error.code)) return "broker-path-denied";
    if (["repository-changed", "ENOENT"].includes(error.code)) return "broker-repository-changed";
    if (["EACCES", "EPERM"].includes(error.code)) return "broker-access-denied";
    if (error.code === "repository-cancelled") return "broker-request-cancelled";
    if (error.code === "repository-byte-limit") return "broker-large-file";
    return "broker-read-unavailable";
  }
  async function perform(name, args, callSignal) {
    await repository.checkRoot();
    if (callSignal?.aborted || signal?.aborted) reject("broker-request-cancelled");
    if (name === "list_files") {
      argsObject(args, ["contains", "cursor", "limit"]);
      const contains = text(args.contains, "", 256), limit = integer(args.limit, 100, 1, 100);
      const bind = binding(name, { contains }), candidates = paths.filter((p) => p.includes(contains));
      const { index } = cursorDecode(args.cursor, bind, candidates.length);
      const selected = []; let bytes = 0;
      for (const relative of candidates.slice(index, index + limit)) {
        const size = Buffer.byteLength(JSON.stringify(relative)) + 1;
        if (bytes + size > 32 * 1024) break;
        selected.push(relative); bytes += size;
      }
      const next = index + selected.length;
      return { paths: selected, total_files: candidates.length, remaining_files: candidates.length - next,
        excluded_files: excluded, exclusion_reasons: exclusions, complete: next === candidates.length && (!live || snapshot.catalog.untracked === "complete"),
        next_cursor: next < candidates.length ? cursorEncode(bind, { index: next, line: 0, column: 0 }) : null };
    }
    if (name === "read_lines") {
      argsObject(args, ["path", "line_start", "line_end", "cursor"]);
      const start = integer(args.line_start, 1, 1, 10_000_000), end = integer(args.line_end, start + 79, start, start + 199);
      const bind = binding(name, { path: args.path, start, end });
      const cursor = cursorDecode(args.cursor, bind, 0);
      const lines = linesOf(await read(args.path, callSignal));
      if (start > lines.length) reject("broker-invalid-range");
      const last = Math.min(end, lines.length), first = cursor.line || start - 1;
      if (first < start - 1 || first >= last || cursor.column > lines[first].length) reject("broker-invalid-cursor");
      let line = first, column = cursor.column, output = "";
      // 6000 UTF-16 units fit even worst-case JSON escaping within the output cap.
      while (line < last && output.length < 6000) {
        const part = lines[line].slice(column, column + 6000 - output.length);
        output += part; column += part.length;
        if (column < lines[line].length || (output.length === 6000 && line + 1 < last)) break;
        line++; column = 0;
        if (line < last && output.length < 6000) output += "\n";
      }
      const more = line < last;
      return { path: args.path, line_start: first + 1, line_end: more ? line + 1 : last, column_start: cursor.column + 1,
        text: output, truncated: more, next_cursor: more ? cursorEncode(bind, { index: 0, line, column }) : null };
    }
    if (name === "search") {
      argsObject(args, ["query", "path", "cursor", "limit"]);
      const query = text(args.query, "", 256);
      if (!query) reject();
      const limit = integer(args.limit, 30, 1, 100);
      if (args.path !== undefined && (!readableRepositoryPath(args.path) || !allowed.has(args.path))) reject("broker-path-denied");
      const candidates = args.path === undefined ? paths : [args.path], bind = binding(name, { query, path: args.path ?? null });
      const cursor = cursorDecode(args.cursor, bind, candidates.length);
      let index = cursor.index, nextLine = cursor.line, scanned = 0, bytes = 0, outputBytes = 0, unreadable = 0;
      const matches = [], skipped = {}, deadline = Date.now() + 5000;
      let reason = null;
      outer: for (; index < candidates.length; index++, nextLine = 0) {
        const relative = candidates[index], entry = snapshot.entries.get(relative);
        if (Date.now() > deadline || scanned >= 1000 || bytes + entry.bytes > 16 * 1024 * 1024) { reason = "scan-budget"; break; }
        if (callSignal?.aborted) reject("broker-request-cancelled");
        scanned++;
        let contents;
        try { contents = await read(relative, callSignal, 16 * 1024 * 1024 - bytes); }
        catch (error) {
          const code = publicCode(error);
          if (code === "broker-scan-budget") { scanned--; reason = "scan-budget"; break; }
          bytes += error instanceof RepositoryReadError ? error.bytes : 0;
          if (["broker-non-text-file", "broker-content-denied", "broker-path-denied", "broker-access-denied", "broker-large-file",
            ...(live ? ["broker-repository-changed"] : [])].includes(code)) {
            unreadable++; skipped[code] = (skipped[code] ?? 0) + 1; continue;
          }
          throw error;
        }
        bytes += live ? observed.get(relative).bytes : entry.bytes;
        const lines = linesOf(contents);
        for (let line = nextLine; line < lines.length; line++) {
          const column = lines[line].indexOf(query);
          if (column < 0) continue;
          const excerptStart = Math.max(0, column - 80), excerpt = lines[line].slice(excerptStart, excerptStart + 300);
          const match = { path: relative, line: line + 1, column: column + 1, text: excerpt,
            text_truncated: excerpt.length !== lines[line].length };
          const size = Buffer.byteLength(JSON.stringify(match));
          if (matches.length >= limit || outputBytes + size > 32 * 1024) { nextLine = line; reason = "result-budget"; break outer; }
          matches.push(match); outputBytes += size;
        }
      }
      const remaining = candidates.length - index;
      return { matches, scope: "eligible-text-files", total_files: candidates.length, scanned_files: scanned, bytes_read: bytes,
        excluded_files: excluded, exclusion_reasons: exclusions, unreadable_files: unreadable, unreadable_reasons: skipped,
        remaining_files: remaining, complete: remaining === 0 && unreadable === 0 && (!live || snapshot.catalog.untracked === "complete"), truncated: remaining > 0,
        stop_reason: reason, matches_truncated_in_last_file: remaining > 0 && nextLine > 0,
        next_cursor: remaining > 0 ? cursorEncode(bind, { index, line: nextLine, column: 0 }) : null };
    }
    reject();
  }
  return { paths: Object.freeze([...paths]),
    async call(name, args = {}, options = {}) {
      try {
        const result = { ...(await perform(name, args, options.signal)), fingerprint_digest: snapshot.public.digest,
          ...(live ? { consistency: "observed-files", inventory: snapshot.catalog,
            ...(typeof args.path === "string" && observed.has(args.path) ? { content_digest: observed.get(args.path).digest } : {}) } : {}) };
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) reject("broker-output-limit");
        return result;
      } catch (error) { reject(publicCode(error)); }
    },
  };
}
