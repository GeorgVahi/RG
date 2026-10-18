import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { OperationError } from "./bounded-process.mjs";

export const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
export const identity = (info) => ({ dev: String(info.dev), ino: String(info.ino) });
const sameFile = (a, b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
// File IDs on NTFS/SMB can exceed Number.MAX_SAFE_INTEGER. Keep identities and
// nanosecond timestamps lossless while bounding byte sizes separately.
const statData = (info) => ({ dev: String(info.dev), ino: String(info.ino), size: Number(info.size), nlink: Number(info.nlink),
  mtimeMs: String(info.mtimeNs), ctimeMs: String(info.ctimeNs),
  isFile: () => info.isFile(), isDirectory: () => info.isDirectory(), isSymbolicLink: () => info.isSymbolicLink() });
const lstat = async (file) => statData(await fs.lstat(file, { bigint: true }));
const fail = (code, relative) => { throw new OperationError(code, relative ? { path: relative } : {}); };
export function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 &&
    !/[\\:\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) &&
    !value.split("/").some((part) => !part || part === "." || part === ".." ||
      (process.platform === "win32" && (/[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))));
}

export async function openRepository(repo, expectedIdentity) {
  let root, initial;
  try { root = await fs.realpath(repo); initial = await lstat(root); }
  catch (error) { throw new OperationError("repository-root-unavailable", { io_code: error.code }); }
  if (initial.ino === "0") fail("repository-identity-unavailable");
  if (!initial.isDirectory() || initial.isSymbolicLink() || (expectedIdentity && !sameFile(initial, expectedIdentity))) fail("repository-root-changed");
  async function checkRoot() {
    let current;
    try { current = await lstat(root); }
    catch (error) { throw new OperationError("repository-root-unavailable", { io_code: error.code }); }
    if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(initial, current)) fail("repository-root-changed");
  }
  async function inspect(relative, { allowMissing = false, allowLink = false } = {}) {
    if (!safeRelative(relative)) fail("repository-path-denied", relative);
    await checkRoot();
    const parts = relative.split("/");
    let full = root, info;
    for (let index = 0; index < parts.length; index++) {
      full = path.join(full, parts[index]);
      try { info = await lstat(full); }
      catch (error) {
        if (allowMissing && error.code === "ENOENT") { await checkRoot(); return { full: path.join(root, ...parts), info: null }; }
        throw error;
      }
      if (info.isSymbolicLink() && !(allowLink && index === parts.length - 1)) {
        throw new OperationError("repository-linked-path", { path: relative, link_digest: createHash("sha256").update(await fs.readlink(full)).digest("hex") });
      }
      if (index < parts.length - 1 && !info.isDirectory()) fail("repository-path-denied", relative);
    }
    return { full, info };
  }
  async function read(relative, { maximumBytes = 2 * 1024 * 1024 * 1024, collect = false,
    expected, signal, inspection, onBytes = () => {}, deadline = Infinity } = {}) {
    const check = () => {
      if (signal?.aborted) fail("repository-cancelled", relative);
      if (Date.now() >= deadline) fail("repository-timeout", relative);
    };
    check();
    const { full, info } = inspection ?? await inspect(relative);
    if (info.ino === "0") fail("repository-identity-unavailable", relative);
    if (!info.isFile() || info.nlink !== 1) fail("repository-path-denied", relative);
    if (info.size > maximumBytes) fail("repository-byte-limit", relative);
    if (expected && info.size !== expected.bytes) fail("repository-changed", relative);
    const handle = await fs.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = statData(await handle.stat({ bigint: true }));
      if (!opened.isFile() || opened.nlink !== 1 || !sameFile(info, opened)) fail("repository-path-denied", relative);
      // The open descriptor must name the file inspected through safe ancestors.
      // A junction swap before open changes its identity; a later swap cannot redirect this descriptor.
      if (opened.ctimeMs !== info.ctimeMs || opened.size !== info.size) fail("repository-changed", relative);
      const hash = createHash("sha256").update("rg-worktree-entry-file-v1\0");
      let bytes = 0, newlines = 0, last = -1;
      const chunks = [], buffer = Buffer.allocUnsafe(128 * 1024);
      while (true) {
        check();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > maximumBytes || bytes > opened.size) fail("repository-changed", relative);
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk); onBytes(bytesRead);
        for (let index = 0; index < bytesRead; index++) if (chunk[index] === 10) newlines++;
        last = chunk.at(-1);
        if (collect) chunks.push(Buffer.from(chunk));
      }
      check();
      const after = statData(await handle.stat({ bigint: true }));
      const current = await inspect(relative);
      if (!sameFile(opened, current.info) || !sameFile(opened, after) || opened.nlink !== after.nlink ||
          opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs || bytes !== opened.size) fail("repository-changed", relative);
      const digest = hash.digest("hex");
      if (expected && (expected.digest !== digest || bytes !== expected.bytes)) fail("repository-changed", relative);
      return { kind: "file", bytes, lines: bytes === 0 ? 1 : newlines + (last !== 10 ? 1 : 0), digest,
        ...(collect ? { contents: Buffer.concat(chunks) } : {}) };
    } finally { await handle.close(); }
  }
  return { root, identity: identity(initial), checkRoot, inspect, read };
}
