import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { computeFingerprint } from "../scripts/rg.mjs";
import { buildSnapshot, encodeManifest, decodeManifest, digest } from "../scripts/snapshot.mjs";
import { runBounded } from "../scripts/bounded-process.mjs";
import { openRepository } from "../scripts/repository-fs.mjs";

async function fixture(t) {
  // Windows CI can expose TEMP through an 8.3 alias; hooks must target the same
  // canonical paths that the production reader inspects.
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const repo = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, "rg-snapshot-test-")));
  t.after(async () => {
    assert.equal(path.dirname(repo), temporaryRoot);
    assert.match(path.basename(repo), /^rg-snapshot-test-/);
    await fs.rm(repo, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  await fs.writeFile(path.join(repo, "owner.js"), "export const owner = 1;\n");
  git("add", "owner.js");
  return { repo, git };
}

test("deleted tracked files are stable tombstones, never readable evidence", async (t) => {
  const { repo, git } = await fixture(t);
  const before = await computeFingerprint(repo);
  await fs.unlink(path.join(repo, "owner.js"));
  const deleted = await computeFingerprint(repo);
  assert.equal(deleted.entries.get("owner.js").kind, "deleted");
  assert.equal(deleted.lineCounts.get("owner.js"), 0);
  assert.notEqual(before.public.digest, deleted.public.digest);
  assert.deepEqual((await computeFingerprint(repo)).public, deleted.public);
  git("add", "-u");
  const staged = await computeFingerprint(repo);
  assert.equal(staged.paths.has("owner.js"), false);
  assert.notEqual(staged.public.digest, deleted.public.digest);
});

test("sparse absence and an uninitialized gitlink have explicit stable states", async (t) => {
  const { repo, git } = await fixture(t);
  git("update-index", "--skip-worktree", "owner.js");
  await fs.unlink(path.join(repo, "owner.js"));
  git("update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,submodule");
  await fs.mkdir(path.join(repo, "submodule"));
  const snapshot = await computeFingerprint(repo);
  assert.equal(snapshot.entries.get("owner.js").kind, "sparse");
  assert.equal(snapshot.entries.get("submodule").kind, "gitlink");
  assert.equal(snapshot.entries.get("submodule").state, "uninitialized");
  assert.deepEqual((await computeFingerprint(repo)).public, snapshot.public);
});

test("snapshot deadline is a typed failure with bounded elapsed time", async (t) => {
  const { repo } = await fixture(t);
  const started = Date.now();
  await assert.rejects(computeFingerprint(repo, { maximumMs: 1 }), { code: "fingerprint-timeout" });
  assert.ok(Date.now() - started < 5000);
});

test("staged rename, untracked replacement, conflict stages and type changes affect the snapshot", async (t) => {
  const { repo, git } = await fixture(t);
  const before = await computeFingerprint(repo);
  git("mv", "owner.js", "renamed.js");
  const renamed = await computeFingerprint(repo);
  assert.equal(renamed.paths.has("owner.js"), false);
  assert.equal(renamed.paths.has("renamed.js"), true);
  await fs.writeFile(path.join(repo, "owner.js"), "new untracked owner\n");
  const replacement = await computeFingerprint(repo);
  assert.equal(replacement.entries.get("owner.js").index.tracked, false);
  assert.notEqual(before.public.digest, replacement.public.digest);
  const oid = git("hash-object", "renamed.js").trim();
  execFileSync("git", ["-C", repo, "update-index", "--index-info"], { input:
    `0 ${"0".repeat(40)}\trenamed.js\n100644 ${oid} 1\trenamed.js\n100644 ${oid} 2\trenamed.js\n100644 ${oid} 3\trenamed.js\n` });
  const conflicted = await computeFingerprint(repo);
  assert.deepEqual(conflicted.entries.get("renamed.js").index.stages.map((stage) => stage.stage), [1, 2, 3]);
  await fs.unlink(path.join(repo, "renamed.js"));
  await fs.mkdir(path.join(repo, "renamed.js"));
  await fs.writeFile(path.join(repo, "renamed.js", "child.js"), "child\n");
  const directory = await computeFingerprint(repo);
  assert.equal(directory.entries.get("renamed.js").kind, "directory");
  assert.equal(directory.entries.get("renamed.js/child.js").kind, "file");
});

test("permission and disconnected-root failures are not deletion tombstones", async (t) => {
  const { repo } = await fixture(t);
  const original = fs.lstat;
  fs.lstat = async (file, ...args) => {
    if (file === path.join(repo, "owner.js")) throw Object.assign(new Error(), { code: "EACCES" });
    return original(file, ...args);
  };
  try {
    await assert.rejects(buildSnapshot(repo), (error) => error.code === "fingerprint-access-denied" && error.details.path === "owner.js");
  } finally { fs.lstat = original; }
  await assert.rejects(computeFingerprint(path.join(repo, "missing-root")), { code: "fingerprint-root-unavailable" });
});

test("snapshot never follows an external ancestor junction into file contents", async (t) => {
  const { repo, git } = await fixture(t), outside = (await fixture(t)).repo;
  await fs.mkdir(path.join(repo, "nested"));
  await fs.writeFile(path.join(repo, "nested", "owner.js"), "inside\n");
  git("add", "nested/owner.js");
  await fs.unlink(path.join(repo, "nested", "owner.js"));
  await fs.rmdir(path.join(repo, "nested"));
  await fs.symlink(outside, path.join(repo, "nested"), process.platform === "win32" ? "junction" : "dir");
  const snapshot = await computeFingerprint(repo);
  assert.equal(snapshot.entries.get("nested/owner.js").kind, "linked");
  assert.equal(snapshot.lineCounts.get("nested/owner.js"), 0);
});

test("file replacement during read is rejected before accepting a mixed snapshot", async (t) => {
  const { repo } = await fixture(t);
  const original = fs.open;
  fs.open = async (file, ...args) => {
    const handle = await original(file, ...args);
    if (file !== path.join(repo, "owner.js")) return handle;
    const read = handle.read.bind(handle);
    let changed = false;
    handle.read = async (...parameters) => {
      const result = await read(...parameters);
      if (!changed) { changed = true; await fs.writeFile(file, "changed contents during read\n"); }
      return result;
    };
    return handle;
  };
  try { await assert.rejects(buildSnapshot(repo), { code: "fingerprint-concurrent-change" }); }
  finally { fs.open = original; }
});

test("manifest is metadata only and rejects tampering, stale age and wrong run/root bindings", async (t) => {
  const { repo } = await fixture(t), snapshot = await computeFingerprint(repo);
  const manifest = encodeManifest(snapshot, "test-run");
  const options = { expectedDigest: manifest.digest, fingerprint: snapshot.public.digest, repo: snapshot.root, runId: "test-run" };
  assert.equal(manifest.content.includes("export const owner = 1"), false);
  assert.deepEqual((await decodeManifest(manifest.content, options)).public, snapshot.public);
  for (const changed of [{ runId: "other" }, { repo: path.dirname(repo) }, { fingerprint: "0".repeat(64) }]) {
    await assert.rejects(decodeManifest(manifest.content, { ...options, ...changed }), { code: "broker-manifest-invalid" });
  }
  await assert.rejects(decodeManifest(manifest.content + " ", options), { code: "broker-manifest-invalid" });
  const stale = JSON.parse(manifest.content); stale.created_at = Date.now() - 1_900_000;
  const content = JSON.stringify(stale);
  await assert.rejects(decodeManifest(content, { ...options, expectedDigest: digest(content) }), { code: "broker-manifest-invalid" });
  const bad = JSON.parse(manifest.content); bad.snapshot.entries[0][1].digest = "0".repeat(64);
  const tampered = JSON.stringify(bad);
  await assert.rejects(decodeManifest(tampered, { ...options, expectedDigest: digest(tampered) }), { code: "broker-manifest-invalid" });
});

test("a hung filesystem worker is actually terminated within the fingerprint deadline", async (t) => {
  const { repo } = await fixture(t), hook = path.join(repo, "hang-hook.mjs"), pidFile = path.join(repo, "worker.pid");
  await fs.writeFile(hook, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nfs.promises.open = async () => new Promise(() => {}); setInterval(() => {}, 1000);\n`);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${pathToFileURL(hook).href}`;
  const started = Date.now();
  try { await assert.rejects(computeFingerprint(repo, { maximumMs: 1000 }), { code: "fingerprint-timeout" }); }
  finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
  assert.ok(Date.now() - started < 5000);
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("cancellation terminates the owned child tree and output limits fail closed", async (t) => {
  const { repo } = await fixture(t), pidFile = path.join(repo, "grandchild.pid");
  const child = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const runner = new URL("../scripts/bounded-process.mjs", import.meta.url).href;
  const parent = `import(${JSON.stringify(runner)}).then(({runBounded})=>runBounded(process.execPath, ['-e', ${JSON.stringify(child)}])); setInterval(() => {}, 1000);`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1000);
  try { await assert.rejects(runBounded(process.execPath, ["-e", parent], { signal: controller.signal, prefix: "test" }), { code: "test-cancelled" }); }
  finally { clearTimeout(timer); }
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(runBounded(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000)); setInterval(()=>{},1000)"],
    { maxBuffer: 100, prefix: "test" }), { code: "test-output-limit" });
});

test("initialized submodules expose a metadata boundary, not nested source evidence", async (t) => {
  const { repo, git } = await fixture(t), sub = path.join(repo, "sub");
  await fs.mkdir(sub);
  const subgit = (...args) => execFileSync("git", ["-C", sub, ...args], { encoding: "utf8" });
  subgit("init", "--quiet");
  await fs.writeFile(path.join(sub, "source.js"), "original\n");
  subgit("add", "source.js");
  subgit("-c", "user.name=RG fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
  git("update-index", "--add", "--cacheinfo", `160000,${subgit("rev-parse", "HEAD").trim()},sub`);
  const clean = await computeFingerprint(repo);
  assert.equal(clean.entries.get("sub").state, "initialized");
  assert.equal(clean.paths.has("sub/source.js"), false);
  await fs.writeFile(path.join(sub, "source.js"), "changed\n");
  assert.notEqual((await computeFingerprint(repo)).public.digest, clean.public.digest);
});

test("index-only mutation during reading retains evidence of inventory drift", async (t) => {
  const { repo, git } = await fixture(t);
  const original = fs.open; let changed = false;
  fs.open = async (file, ...args) => {
    const handle = await original(file, ...args);
    if (file === path.join(repo, "owner.js") && !changed) { changed = true; git("update-index", "--skip-worktree", "owner.js"); }
    return handle;
  };
  try {
    await assert.rejects(buildSnapshot(repo), (error) => error.code === "fingerprint-concurrent-change" &&
      error.details.inventory_before[0][1].sparse === false && error.details.inventory_after[0][1].sparse === true);
  } finally { fs.open = original; }
});

test("root identity preserves 64-bit file IDs and rejects unavailable identities", async (t) => {
  const { repo } = await fixture(t), original = fs.lstat;
  let ino = 9007199254740993n;
  fs.lstat = async (file, options) => {
    const info = await original(file, options);
    if (file === repo) { assert.equal(options.bigint, true); info.ino = ino; }
    return info;
  };
  try {
    const repository = await openRepository(repo);
    assert.equal(repository.identity.ino, "9007199254740993");
    ino = 9007199254740992n;
    await assert.rejects(repository.checkRoot(), { code: "repository-root-changed" });
    ino = 0n;
    await assert.rejects(openRepository(repo), { code: "repository-identity-unavailable" });
  } finally { fs.lstat = original; }
});
