import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded, OperationError } from "./bounded-process.mjs";
import { openRepository, safeRelative, samePath, identity } from "./repository-fs.mjs";
import { digest, serializeSnapshot, hydrateSnapshot, snapshotDigest, MAX_SNAPSHOT_BYTES } from "./snapshot.mjs";

export const CATALOG_INVENTORY = "git-path-catalog-v1";
export const isCatalog = (snapshot) => snapshot?.public?.inventory === CATALOG_INVENTORY;
const fail = (code, details = {}) => { throw new OperationError(code, details); };
const decode = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const sameIdentity = (a, b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
const validEntry = (entry) => entry?.kind === "file" && /^[a-f0-9]{64}$/.test(entry.digest) &&
  Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= 2 * 1024 * 1024 &&
  Number.isSafeInteger(entry.lines) && entry.lines >= 1;

// Read Git's index, not every worktree file. Untracked enumeration is optional,
// bounded work: its failure cannot be silently presented as complete coverage.
export async function buildCatalog(repo, { maximumMs = 120_000, untrackedMs = 5000, signal, onProgress = () => {} } = {}) {
  const started = Date.now(), deadline = started + maximumMs;
  const metrics = { stage: "catalog-root", files_total: 0, files_scanned: 0, bytes_read: 0, elapsed_ms: 0 };
  const progress = () => { metrics.elapsed_ms = Date.now() - started; onProgress({ ...metrics }); };
  const timer = setInterval(progress, 2000); timer.unref?.();
  try {
    const repository = await openRepository(repo);
    metrics.stage = "catalog-index"; progress();
    const git = (args, timeoutMs) => runBounded("git", ["--no-optional-locks", "-C", repository.root, ...args], {
      cwd: path.dirname(process.execPath), timeoutMs: Math.min(timeoutMs, deadline - Date.now()), signal, prefix: "catalog-git", maxBuffer: MAX_SNAPSHOT_BYTES });
    const tracked = await git(["ls-files", "--cached", "--stage", "-z"], maximumMs);
    if (tracked.status !== 0) fail("catalog-index-unavailable");
    const entries = new Map();
    for (const record of decode(tracked.stdout).split("\0")) {
      if (!record) continue;
      const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match || !safeRelative(match[4])) fail("catalog-inventory-invalid");
      const entry = entries.get(match[4]) ?? { kind: "candidate", bytes: 0, lines: 0, index: [] };
      entry.index.push({ mode: match[1], oid: match[2], stage: Number(match[3]) });
      entries.set(match[4], entry);
    }
    metrics.stage = "catalog-untracked"; progress();
    let untracked = "complete";
    try {
      const others = await git(["ls-files", "--others", "--exclude-standard", "-z"], untrackedMs);
      if (others.status !== 0) fail("catalog-untracked-unavailable");
      for (const relative of decode(others.stdout).split("\0")) {
        if (!relative) continue;
        if (!safeRelative(relative)) fail("catalog-inventory-invalid");
        if (!entries.has(relative)) entries.set(relative, { kind: "candidate", bytes: 0, lines: 0, index: [] });
      }
    } catch (error) {
      if (error.code !== "catalog-git-timeout") throw error;
      untracked = "incomplete-timeout";
    }
    if (entries.size > 100_000) fail("catalog-file-limit");
    const ordered = new Map([...entries].sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b))));
    const catalog = { captured_at: new Date().toISOString(), untracked, scope: "paths-at-start", atomic: false };
    const token = digest(JSON.stringify([CATALOG_INVENTORY, repository.identity, [...ordered], catalog]));
    await repository.checkRoot();
    metrics.stage = "completed"; metrics.files_total = ordered.size; progress();
    return { public: { algorithm: "sha256", digest: token, files: ordered.size, bytes: 0, inventory: CATALOG_INVENTORY },
      root: repository.root, rootIdentity: repository.identity, paths: new Set(ordered.keys()), entries: ordered,
      lineCounts: new Map(), ignored: [], catalog, metrics };
  } finally { clearInterval(timer); }
}

export function encodeCatalogManifest(snapshot, runId) {
  const content = JSON.stringify({ schema: "rg.catalog-manifest.v1", run_id: runId, created_at: Date.now(), snapshot: serializeSnapshot(snapshot) });
  if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) fail("catalog-manifest-limit");
  return { content, digest: digest(content), runId };
}

export async function decodeCatalogManifest(content, { expectedDigest, fingerprint, repo, runId }) {
  try {
    if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES || digest(content) !== expectedDigest) throw new Error();
    const value = JSON.parse(content), item = value.snapshot;
    if (value.schema !== "rg.catalog-manifest.v1" || value.run_id !== runId || !Number.isFinite(value.created_at) ||
        value.created_at > Date.now() + 60_000 || Date.now() - value.created_at > 1_800_000 ||
        !isCatalog(item) || !samePath(item.root, repo) || item.public.digest !== fingerprint || item.public.bytes !== 0 ||
        !Array.isArray(item.paths) || !Array.isArray(item.entries) || item.paths.length > 100_000 ||
        item.paths.length !== item.public.files || item.entries.length !== item.paths.length ||
        !item.paths.every(safeRelative) || !["complete", "incomplete-timeout"].includes(item.catalog?.untracked)) throw new Error();
    const snapshot = hydrateSnapshot(item);
    if (snapshot.paths.size !== item.paths.length || snapshot.entries.size !== item.entries.length ||
        JSON.stringify(item.paths) !== JSON.stringify([...snapshot.entries.keys()]) ||
        [...snapshot.entries.values()].some((entry) => entry.kind !== "candidate" || !Array.isArray(entry.index)) ||
        digest(JSON.stringify([CATALOG_INVENTORY, item.rootIdentity, item.entries, item.catalog])) !== fingerprint) throw new Error();
    await openRepository(repo, snapshot.rootIdentity);
    return snapshot;
  } catch { fail("broker-manifest-invalid"); }
}

// The broker can append only to an owner-created artifact whose file and parent
// identities are bound into the manifest. The scout cannot create/replace it.
export async function createObservationJournal(file, snapshot, runId) {
  const parent = await fs.lstat(path.dirname(file), { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail("observation-journal-invalid");
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ schema: "rg.observations.v1", run_id: runId, catalog_digest: snapshot.public.digest }) + "\n");
    const info = await handle.stat({ bigint: true });
    return { path: file, ...identity(info), parent: identity(parent), run_id: runId, catalog_digest: snapshot.public.digest };
  } finally { await handle.close(); }
}

async function journalHandle(journal, write = false) {
  if (!journal || typeof journal.path !== "string" || !path.isAbsolute(journal.path)) fail("observation-journal-invalid");
  const parent = await fs.lstat(path.dirname(journal.path), { bigint: true });
  const info = await fs.lstat(journal.path, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink() || !sameIdentity(parent, journal.parent) ||
      !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || !sameIdentity(info, journal) || info.size > MAX_SNAPSHOT_BYTES) fail("observation-journal-invalid");
  const handle = await fs.open(journal.path, (write ? constants.O_WRONLY | constants.O_APPEND : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
  const opened = await handle.stat({ bigint: true });
  if (!sameIdentity(opened, info) || opened.nlink !== 1n || !opened.isFile()) {
    await handle.close(); fail("observation-journal-invalid");
  }
  return handle;
}

export async function appendObservation(journal, relative, entry) {
  if (!safeRelative(relative) || !validEntry(entry)) fail("observation-journal-invalid");
  const record = JSON.stringify({ path: relative, entry: { kind: "file", bytes: entry.bytes, lines: entry.lines, digest: entry.digest } }) + "\n";
  const handle = await journalHandle(journal, true);
  try {
    if ((await handle.stat()).size + Buffer.byteLength(record) > MAX_SNAPSHOT_BYTES) fail("observation-journal-limit");
    await handle.writeFile(record);
  } finally { await handle.close(); }
}

export async function readObservations(snapshot) {
  const journal = snapshot.journal, handle = await journalHandle(journal);
  let content;
  try {
    const before = await handle.stat({ bigint: true });
    const chunks = [], buffer = Buffer.allocUnsafe(64 * 1024); let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_SNAPSHOT_BYTES || BigInt(size) > before.size) fail("observation-journal-invalid");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    content = Buffer.concat(chunks);
    const after = await handle.stat({ bigint: true });
    if (BigInt(content.length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs || after.nlink !== 1n || !content.length || content.at(-1) !== 10) fail("observation-journal-invalid");
  } finally { await handle.close(); }
  const lines = decode(content).trimEnd().split("\n"), header = JSON.parse(lines.shift());
  if (header.schema !== "rg.observations.v1" || header.run_id !== journal.run_id ||
      header.catalog_digest !== snapshot.public.digest || header.catalog_digest !== journal.catalog_digest) fail("observation-journal-invalid");
  const entries = new Map(), changed = new Set();
  for (const line of lines) {
    const record = JSON.parse(line);
    if (!snapshot.paths.has(record.path) || !validEntry(record.entry)) fail("observation-journal-invalid");
    const previous = entries.get(record.path);
    if (previous && previous.digest !== record.entry.digest) changed.add(record.path);
    entries.set(record.path, previous ?? record.entry);
  }
  return { entries, changed };
}

// Fresh policy per operation, never a cross-call cache. NUL framing preserves
// literal Unicode/space/dash paths and --no-index also checks tracked files.
export async function currentIgnoredPaths(repo, relatives, { signal, deadline = Date.now() + 5000 } = {}) {
  const paths = [...new Set(relatives)], ignored = new Set();
  if (!paths.every(safeRelative)) fail("broker-path-denied");
  for (let offset = 0; offset < paths.length; offset += 500) {
    const batch = new Set(paths.slice(offset, offset + 500)), input = [...batch].join("\0") + "\0";
    const outcome = await runBounded("git", ["--no-optional-locks", "-C", repo, "check-ignore", "--no-index", "-z", "--stdin"], {
      input, cwd: path.dirname(process.execPath), timeoutMs: Math.min(5000, deadline - Date.now()), signal, prefix: "broker-policy",
      maxBuffer: Math.max(64 * 1024, Buffer.byteLength(input)) });
    if (![0, 1].includes(outcome.status)) fail("broker-policy-unavailable");
    let output;
    try { output = decode(outcome.stdout); } catch { fail("broker-policy-unavailable"); }
    if ((outcome.status === 1 && output !== "") || (outcome.status === 0 && !output.endsWith("\0"))) fail("broker-policy-unavailable");
    for (const relative of output ? output.slice(0, -1).split("\0") : []) {
      if (!batch.has(relative) || ignored.has(relative)) fail("broker-policy-unavailable");
      ignored.add(relative);
    }
  }
  return ignored;
}

export async function assertCurrentIgnorePolicy(repo, relative, options) {
  if ((await currentIgnoredPaths(repo, [relative], options)).has(relative)) fail("broker-path-denied");
}

export async function verifyObservations(snapshot, { maximumMs = 120_000, signal, onProgress = () => {} } = {}) {
  const started = Date.now(), deadline = started + maximumMs;
  const { entries, changed } = await readObservations(snapshot);
  const repository = await openRepository(snapshot.root, snapshot.rootIdentity);
  const observed = { ...snapshot, entries, lineCounts: new Map([...entries].map(([p, e]) => [p, e.lines])) };
  const after = new Map(entries), paths = [...entries.keys()];
  const metrics = { stage: "verify-observed", files_total: paths.length, files_scanned: 0, bytes_read: 0, elapsed_ms: 0 };
  const progress = () => { metrics.elapsed_ms = Date.now() - started; onProgress({ ...metrics }); };
  const timer = setInterval(progress, 2000); timer.unref?.();
  try {
    let next = 0;
    const workers = Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (next < paths.length) {
        const relative = paths[next++];
        try {
          const measured = await repository.read(relative, { expected: entries.get(relative), maximumBytes: 2 * 1024 * 1024, signal, deadline });
          metrics.bytes_read += measured.bytes;
        } catch (error) {
          if (!["repository-changed", "ENOENT", "repository-path-denied", "repository-linked-path", "broker-path-denied"].includes(error.code)) throw error;
          changed.add(relative);
        }
        metrics.files_scanned++;
      }
    });
    const results = await Promise.allSettled(workers);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    // Check the entire read set after reading, so an edit to ignore policy while
    // another file is being verified cannot leave an earlier observation valid.
    const unchanged = paths.filter((relative) => !changed.has(relative));
    for (const relative of await currentIgnoredPaths(repository.root, unchanged, { signal, deadline })) changed.add(relative);
    await repository.checkRoot();
    // Invalidate an observation without pretending to know replacement bytes or
    // classifying a content edit as a filesystem type change.
    for (const relative of changed) after.set(relative, { ...entries.get(relative), invalidated: true });
    if (changed.size) fail("observed-files-changed", {
      before: serializeSnapshot(observed), after: serializeSnapshot({ ...observed, entries: after }) });
    metrics.stage = "completed"; progress();
    return { ...observed, metrics, consistency: { schema: "rg.consistency.v1", mode: "observed-files", atomic: false,
      catalog: snapshot.catalog, catalog_files: snapshot.paths.size, verified_files: entries.size,
      verified_bytes: metrics.bytes_read, read_set_digest: snapshotDigest(entries), verified_at: new Date().toISOString() } };
  } finally { clearInterval(timer); }
}

export async function runCatalogOperation(operation, input, limits = {}) {
  const maximumMs = Math.min(limits.maximumMs ?? 120_000, (limits.deadline ?? Infinity) - Date.now());
  let metrics = { stage: operation, files_scanned: 0, bytes_read: 0, elapsed_ms: 0 }, pending = "";
  try {
    const result = await runBounded(process.execPath, [fileURLToPath(new URL("./catalog-worker.mjs", import.meta.url))], {
      cwd: path.dirname(process.execPath),
      input: JSON.stringify({ operation, input: operation === "verify" ? serializeSnapshot(input) : input, maximumMs }),
      timeoutMs: maximumMs, signal: limits.signal, maxBuffer: MAX_SNAPSHOT_BYTES, prefix: "catalog",
      onStderr(chunk) {
        pending += chunk.toString("utf8"); let end;
        while ((end = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try { metrics = JSON.parse(line); limits.onProgress?.(metrics); } catch {}
        }
      } });
    const value = JSON.parse(result.stdout.toString("utf8"));
    if (value.error) fail(value.error.code, value.error.details);
    if (result.status !== 0 || !value.snapshot) fail("catalog-worker-failed");
    return hydrateSnapshot(value.snapshot);
  } catch (error) {
    if (error instanceof OperationError) { error.details = { stage: metrics.stage, metrics, ...error.details }; throw error; }
    fail("catalog-worker-failed", { stage: metrics.stage, metrics });
  }
}
