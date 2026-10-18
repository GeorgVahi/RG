import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { runBounded, OperationError } from "./bounded-process.mjs";
import { openRepository, safeRelative, samePath } from "./repository-fs.mjs";

export const INVENTORY_V2 = "git-worktree-state-v2";
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 100_000, MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const digest = (value) => createHash("sha256").update(value).digest("hex");
const sorted = (values) => [...values].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
const decode = (buffer) => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new OperationError("fingerprint-inventory-invalid"); }
};
const stateEntry = (kind, value, extra = {}) => ({ kind, bytes: 0, lines: 0, digest: digest(JSON.stringify(value)), ...extra });

export function snapshotDigest(entries) {
  const hash = createHash("sha256").update("rg-worktree-state-v2\0");
  for (const relative of sorted(entries.keys())) hash.update(JSON.stringify([relative, entries.get(relative)]) + "\0");
  return hash.digest("hex");
}

export async function buildSnapshot(repo, { maximumMs = 120_000, concurrency = 8, signal,
  onProgress = () => {} } = {}) {
  const started = Date.now(), deadline = started + maximumMs;
  const metrics = { stage: "root", files_total: 0, files_scanned: 0, bytes_read: 0, concurrency, elapsed_ms: 0 };
  let currentPath;
  const progress = () => { metrics.elapsed_ms = Date.now() - started; onProgress({ ...metrics }); };
  const timer = setInterval(progress, 2000); timer.unref?.();
  const git = async (root, args, input) => {
    const result = await runBounded("git", ["--no-optional-locks", "-C", root, ...args], {
      timeoutMs: deadline - Date.now(), signal, input, prefix: "fingerprint-git" });
    if (result.status !== 0) {
      const unsafe = result.stderr.includes(Buffer.from("dubious ownership"));
      throw new OperationError(unsafe ? "git-unsafe-repository" : "fingerprint-git-failed");
    }
    return result.stdout;
  };
  const inventory = async (root) => {
    const tracked = await git(root, ["ls-files", "--cached", "--stage", "-t", "-z"]);
    const others = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const result = new Map();
    for (const record of decode(tracked).split("\0")) {
      if (!record) continue;
      const match = /^([A-Z?]) ([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match || !safeRelative(match[5])) throw new OperationError("fingerprint-inventory-invalid");
      const entry = result.get(match[5]) ?? { tracked: true, stages: [], sparse: false };
      entry.stages.push({ mode: match[2], oid: match[3], stage: Number(match[4]) });
      entry.sparse ||= match[1] === "S";
      result.set(match[5], entry);
    }
    for (const relative of decode(others).split("\0")) {
      if (!relative) continue;
      if (!safeRelative(relative)) throw new OperationError("fingerprint-inventory-invalid");
      if (!result.has(relative)) result.set(relative, { tracked: false, stages: [], sparse: false });
    }
    if (result.size > MAX_FILES) throw new OperationError("fingerprint-file-limit");
    return new Map(sorted(result.keys()).map((relative) => [relative, result.get(relative)]));
  };
  try {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new OperationError("fingerprint-invalid-limits");
    const repository = await openRepository(repo);
    metrics.stage = "inventory"; progress();
    const initial = await inventory(repository.root);
    metrics.files_total = initial.size;
    metrics.stage = "read"; progress();
    const paths = [...initial.keys()], entries = new Map();
    let next = 0, stopped = false;
    async function scan() {
      while (!stopped && next < paths.length) {
        const relative = paths[next++], index = initial.get(relative);
        currentPath = relative;
        try {
        if (Date.now() >= deadline || signal?.aborted) throw new OperationError("fingerprint-timeout");
        let entry;
        let inspected;
        try { inspected = await repository.inspect(relative, { allowMissing: true, allowLink: true }); }
        catch (error) {
          if (error.code !== "repository-linked-path") throw error;
          entries.set(relative, { ...stateEntry("linked", error.details), index });
          metrics.files_scanned++; continue;
        }
        const { full, info } = inspected;
        const gitlink = index.stages.some((item) => item.mode === "160000");
        if (!info) {
          if (!index.tracked) throw new OperationError("fingerprint-concurrent-change", { path: relative });
          entry = stateEntry(gitlink ? "gitlink" : index.sparse ? "sparse" : "deleted", index,
            gitlink ? { state: "uninitialized" } : {});
        } else if (info.isFile()) {
          if (info.nlink !== 1) entry = stateEntry("hardlink", index);
          else entry = await repository.read(relative, { deadline, signal, inspection: inspected, maximumBytes: MAX_BYTES,
            onBytes(bytes) {
              metrics.bytes_read += bytes;
              if (metrics.bytes_read > MAX_BYTES) throw new OperationError("fingerprint-byte-limit");
            } });
        } else if (info.isSymbolicLink()) {
          const target = await fs.readlink(full);
          const after = await repository.inspect(relative, { allowLink: true });
          if (!after.info.isSymbolicLink() || after.info.ino !== info.ino || await fs.readlink(full) !== target) throw new OperationError("fingerprint-concurrent-change", { path: relative });
          entry = { kind: "symlink", bytes: Buffer.byteLength(target), lines: 0, digest: digest(target) };
        } else if (info.isDirectory() && gitlink) {
          // A submodule is a boundary, never recursively exposed as source evidence.
          const local = await runBounded("git", ["--no-optional-locks", "-C", full, "rev-parse", "--show-toplevel"],
            { timeoutMs: deadline - Date.now(), signal, prefix: "fingerprint-git" });
          const initialized = local.status === 0 && samePath(await fs.realpath(decode(local.stdout).trim()), full);
          const state = initialized ? [decode(await git(full, ["rev-parse", "HEAD"])).trim(),
            decode(await git(full, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]))] : index;
          entry = stateEntry("gitlink", state, { state: initialized ? "initialized" : "uninitialized" });
        } else if (info.isDirectory() && index.tracked) entry = stateEntry("directory", index);
        else throw new OperationError("fingerprint-unsupported-file", { path: relative });
        entries.set(relative, { ...entry, index });
        metrics.files_scanned++;
        } catch (error) {
          error.details = { ...error.details, path: error.details?.path ?? relative };
          throw error;
        }
      }
    }
    const workers = Array.from({ length: concurrency }, () => scan().catch((error) => { stopped = true; throw error; }));
    const results = await Promise.allSettled(workers);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    metrics.stage = "inventory-recheck"; progress();
    const again = await inventory(repository.root);
    if (JSON.stringify([...initial]) !== JSON.stringify([...again])) {
      throw new OperationError("fingerprint-concurrent-change", { inventory_before: [...initial], inventory_after: [...again] });
    }
    // One metadata-only ignore pass, reused by the broker; ignored tracked bytes remain fingerprinted.
    metrics.stage = "ignore-policy"; progress();
    const ignored = new Set();
    // Git refuses paths beyond symlinks on POSIX. Non-file states are already
    // ineligible for evidence and must never be traversed for ignore policy.
    const regularPaths = paths.filter((relative) => entries.get(relative).kind === "file");
    for (let offset = 0; offset < regularPaths.length; offset += 500) {
      const result = await runBounded("git", ["--no-optional-locks", "-C", repository.root, "check-ignore", "--no-index", "-z", "--stdin"], {
        input: regularPaths.slice(offset, offset + 500).join("\0") + "\0", timeoutMs: deadline - Date.now(), signal, prefix: "fingerprint-git" });
      if (![0, 1].includes(result.status)) throw new OperationError("fingerprint-ignore-unavailable");
      for (const relative of decode(result.stdout).split("\0")) if (relative) ignored.add(relative);
    }
    await repository.checkRoot();
    const ordered = new Map(paths.map((relative) => [relative, entries.get(relative)]));
    const bytes = [...ordered.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    if (bytes > MAX_BYTES) throw new OperationError("fingerprint-byte-limit");
    metrics.stage = "completed"; progress();
    return { public: { algorithm: "sha256", digest: snapshotDigest(ordered), files: paths.length, bytes, inventory: INVENTORY_V2 },
      root: repository.root, rootIdentity: repository.identity, paths: new Set(paths), entries: ordered,
      lineCounts: new Map([...ordered].map(([relative, entry]) => [relative, entry.lines])), ignored: [...ignored], metrics };
  } catch (error) {
    const code = error.code === "EACCES" || error.code === "EPERM" ? "fingerprint-access-denied"
      : error.code === "ENOENT" || error.code === "repository-changed" ? "fingerprint-concurrent-change"
      : error.code?.startsWith("repository-") ? error.code.replace("repository-", "fingerprint-")
      : error.code?.startsWith("fingerprint-") || error.code === "git-unsafe-repository" ? error.code : "fingerprint-io-unavailable";
    throw new OperationError(code, { ...error.details, ...(/^[A-Z][A-Z0-9_]{1,31}$/.test(error.code ?? "") ? { io_code: error.code } : {}), stage: metrics.stage, ...(currentPath ? { path: error.details?.path ?? currentPath } : {}),
      metrics: { ...metrics, elapsed_ms: Date.now() - started } });
  } finally { clearInterval(timer); }
}

export const serializeSnapshot = (snapshot) => ({ ...snapshot, paths: [...snapshot.paths], entries: [...snapshot.entries], lineCounts: [...snapshot.lineCounts] });
export const hydrateSnapshot = (value) => ({ ...value, paths: new Set(value.paths), entries: new Map(value.entries), lineCounts: new Map(value.lineCounts) });

export function encodeManifest(snapshot, runId) {
  const content = JSON.stringify({ schema: "rg.snapshot-manifest.v2", run_id: runId, created_at: Date.now(), snapshot: serializeSnapshot(snapshot) });
  if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) throw new OperationError("fingerprint-manifest-limit");
  return { content, digest: digest(content), runId };
}

export async function decodeManifest(content, { expectedDigest, fingerprint, repo, runId }) {
  try {
    if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES || digest(content) !== expectedDigest) throw new Error();
    const value = JSON.parse(content), item = value.snapshot;
    if (value.schema !== "rg.snapshot-manifest.v2" || value.run_id !== runId ||
        !Number.isFinite(value.created_at) || value.created_at > Date.now() + 60_000 || Date.now() - value.created_at > 1_800_000 ||
        !samePath(item.root, repo) || item.public.inventory !== INVENTORY_V2 || item.public.digest !== fingerprint ||
        !Array.isArray(item.entries) || item.entries.length > MAX_FILES || item.entries.length !== item.public.files ||
        !Array.isArray(item.paths) || !Array.isArray(item.lineCounts) || !Array.isArray(item.ignored)) throw new Error();
    const snapshot = hydrateSnapshot(item);
    if (snapshot.entries.size !== item.entries.length || snapshot.paths.size !== item.paths.length ||
        JSON.stringify(item.paths) !== JSON.stringify([...snapshot.entries.keys()]) || snapshotDigest(snapshot.entries) !== fingerprint ||
        !item.paths.every(safeRelative) || !item.ignored.every((p) => snapshot.paths.has(p))) throw new Error();
    let bytes = 0;
    for (const [relative, entry] of snapshot.entries) {
      if (!["file", "deleted", "sparse", "gitlink", "symlink", "hardlink", "linked", "directory"].includes(entry.kind) ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !Number.isSafeInteger(entry.lines) || entry.lines < 0 ||
          !/^[a-f0-9]{64}$/.test(entry.digest) || snapshot.lineCounts.get(relative) !== entry.lines) throw new Error();
      bytes += entry.bytes;
    }
    if (bytes !== snapshot.public.bytes || bytes > MAX_BYTES) throw new Error();
    await openRepository(repo, snapshot.rootIdentity);
    return snapshot;
  } catch { throw new OperationError("broker-manifest-invalid"); }
}
