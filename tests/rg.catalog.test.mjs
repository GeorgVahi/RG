import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { buildCatalog, createObservationJournal, appendObservation, verifyObservations, readObservations,
  encodeCatalogManifest, decodeCatalogManifest, runCatalogOperation, currentIgnoredPaths } from "../scripts/catalog.mjs";
import { createRepositoryReader } from "../scripts/repository-reader.mjs";
import { digest } from "../scripts/snapshot.mjs";
import { openRepository } from "../scripts/repository-fs.mjs";

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const base = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, "rg-catalog-test-")));
  const repo = path.join(base, "repo"); await fs.mkdir(repo);
  t.after(async () => {
    assert.equal(path.dirname(base), temporaryRoot);
    assert.match(path.basename(base), /^rg-catalog-test-/);
    await fs.rm(base, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  await fs.writeFile(path.join(repo, "source.js"), "export const owner = 1;\n");
  await fs.writeFile(path.join(repo, "unrelated.js"), "build output v1\n");
  git("add", ".");
  return { base, repo, git };
}

async function readerFor(base, repo, snapshot) {
  snapshot.journal = await createObservationJournal(path.join(base, "observations.jsonl"), snapshot, "test-run");
  return createRepositoryReader({ repo, snapshot,
    onObservation: (relative, entry) => appendObservation(snapshot.journal, relative, entry) });
}

test("catalog never opens unrelated file payloads, even if a build owns them", async (t) => {
  const { repo } = await fixture(t), original = fs.open;
  fs.open = async (file, ...args) => {
    if (file === path.join(repo, "unrelated.js")) assert.fail("catalog opened unrelated content");
    return original(file, ...args);
  };
  try {
    const snapshot = await buildCatalog(repo);
    assert.equal(snapshot.public.inventory, "git-path-catalog-v1");
    assert.equal(snapshot.public.bytes, 0);
    assert.equal(snapshot.metrics.files_scanned, 0);
    assert.equal(snapshot.paths.size, 2);
  } finally { fs.open = original; }
});

test("unrelated edits, deletion and new files do not invalidate observed evidence", async (t) => {
  const { base, repo } = await fixture(t), snapshot = await buildCatalog(repo);
  const reader = await readerFor(base, repo, snapshot);
  await reader.call("read_lines", { path: "source.js", line_start: 1, line_end: 1 });
  await fs.writeFile(path.join(repo, "unrelated.js"), "simultaneous build\n");
  await fs.unlink(path.join(repo, "unrelated.js"));
  await fs.writeFile(path.join(repo, "new.js"), "new file in another chat\n");
  const verified = await verifyObservations(snapshot);
  assert.equal(verified.consistency.verified_files, 1);
  assert.equal(verified.consistency.atomic, false);
  assert.equal(verified.lineCounts.get("source.js"), 1);
  assert.equal(verified.entries.has("unrelated.js"), false);
  assert.equal(verified.paths.has("new.js"), false);
  assert.deepEqual(verified.public, snapshot.public);
});

test("changed observed bytes are rejected even if a later tool error is ignored", async (t) => {
  const { base, repo } = await fixture(t), snapshot = await buildCatalog(repo);
  const reader = await readerFor(base, repo, snapshot);
  await reader.call("read_lines", { path: "source.js" });
  await fs.writeFile(path.join(repo, "source.js"), "export const owner = 2;\n");
  await assert.rejects(reader.call("read_lines", { path: "source.js" }), { code: "broker-repository-changed" });
  await fs.writeFile(path.join(repo, "source.js"), "export const owner = 1;\n");
  await assert.rejects(verifyObservations(snapshot), { code: "observed-files-changed" });
});

test("a deletion during discovery is disclosed and does not hide healthy files", async (t) => {
  const { base, repo } = await fixture(t), snapshot = await buildCatalog(repo);
  const reader = await readerFor(base, repo, snapshot);
  await fs.unlink(path.join(repo, "unrelated.js"));
  const result = await reader.call("search", { query: "owner" });
  assert.equal(result.matches[0].path, "source.js");
  assert.equal(result.unreadable_reasons["broker-repository-changed"], 1);
  assert.equal(result.complete, false);
  assert.equal((await verifyObservations(snapshot)).consistency.verified_files, 1);
});

test("slow untracked enumeration yields explicit incomplete catalog, not a failed tracked search", async (t) => {
  const { base, repo } = await fixture(t);
  await fs.writeFile(path.join(repo, "new.js"), "new untracked owner\n");
  const snapshot = await buildCatalog(repo, { untrackedMs: 0 });
  assert.equal(snapshot.catalog.untracked, "incomplete-timeout");
  assert.equal(snapshot.paths.has("source.js"), true);
  assert.equal(snapshot.paths.has("new.js"), false);
  const reader = await readerFor(base, repo, snapshot);
  const found = await reader.call("search", { query: "owner", path: "source.js" });
  assert.equal(found.matches.length, 1);
  assert.equal(found.complete, false);
  assert.equal(found.inventory.untracked, "incomplete-timeout");
  assert.equal((await reader.call("list_files")).complete, false);
});

test("current ignore policy is checked before disclosure and again before acceptance", async (t) => {
  const { base, repo } = await fixture(t), snapshot = await buildCatalog(repo);
  const reader = await readerFor(base, repo, snapshot);
  await reader.call("read_lines", { path: "source.js" });
  await fs.writeFile(path.join(repo, ".gitignore"), "source.js\nunrelated.js\n");
  await assert.rejects(reader.call("read_lines", { path: "unrelated.js" }), { code: "broker-path-denied" });
  await assert.rejects(verifyObservations(snapshot), { code: "observed-files-changed" });
});

test("catalog manifest is metadata only, mode-bound, root-bound and integrity checked", async (t) => {
  const { repo } = await fixture(t), snapshot = await buildCatalog(repo);
  const manifest = encodeCatalogManifest(snapshot, "test-run");
  const options = { expectedDigest: manifest.digest, fingerprint: snapshot.public.digest, repo, runId: "test-run" };
  assert.equal(manifest.content.includes("export const owner"), false);
  assert.equal((await decodeCatalogManifest(manifest.content, options)).paths.size, 2);
  await assert.rejects(decodeCatalogManifest(manifest.content, { ...options, runId: "other" }), { code: "broker-manifest-invalid" });
  const altered = JSON.parse(manifest.content); altered.snapshot.entries.pop();
  const content = JSON.stringify(altered);
  await assert.rejects(decodeCatalogManifest(content, { ...options, expectedDigest: digest(content) }), { code: "broker-manifest-invalid" });
});

test("journal rejects replaced files and incomplete records", async (t) => {
  const { base, repo } = await fixture(t), snapshot = await buildCatalog(repo);
  const reader = await readerFor(base, repo, snapshot);
  await reader.call("read_lines", { path: "source.js" });
  const file = snapshot.journal.path;
  const content = await fs.readFile(file);
  await fs.appendFile(file, "{");
  await assert.rejects(readObservations(snapshot), { code: "observation-journal-invalid" });
  await fs.rename(file, path.join(base, "old-journal"));
  await fs.writeFile(file, content);
  await assert.rejects(readObservations(snapshot), { code: "observation-journal-invalid" });
});

test("catalog reader retains junction, hardlink and secret confinement", async (t) => {
  const { base, repo, git } = await fixture(t);
  const outside = path.join(base, "outside"); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.js"), "outside secret\n");
  await fs.mkdir(path.join(repo, "nested"));
  await fs.writeFile(path.join(repo, "nested", "secret.js"), "inside\n");
  git("add", ".");
  await fs.link(path.join(repo, "source.js"), path.join(repo, "hard.js"));
  await fs.writeFile(path.join(repo, ".env"), "synthetic forbidden fixture\n");
  const snapshot = await buildCatalog(repo), reader = await readerFor(base, repo, snapshot);
  await fs.rename(path.join(repo, "nested"), path.join(repo, "moved"));
  await fs.symlink(outside, path.join(repo, "nested"), process.platform === "win32" ? "junction" : "dir");
  for (const relative of ["nested/secret.js", "hard.js", ".env", "../outside/secret.js"]) {
    await assert.rejects(reader.call("read_lines", { path: relative }), { code: "broker-path-denied" });
  }
  assert.equal((await readObservations(snapshot)).entries.size, 0);
  const result = await reader.call("search", { query: "build" });
  assert.deepEqual(result.matches.map((item) => item.path), ["unrelated.js"]);
  assert.equal(result.unreadable_reasons["broker-path-denied"], 3);
});

test("owned catalog worker enforces a real deadline", async (t) => {
  const { repo } = await fixture(t);
  const start = Date.now();
  await assert.rejects(runCatalogOperation("build", repo, { maximumMs: 1 }), { code: "catalog-timeout" });
  assert.ok(Date.now() - start < 5000);
});

function countGit(t) {
  const original = childProcess.spawn;
  let count = 0;
  t.mock.method(childProcess, "spawn", function (command, ...args) {
    if (command === "git") count++;
    return original.call(this, command, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => count;
}

test("Git uses its explicit repository without inheriting the NAS startup directory", async (t) => {
  const { base, repo } = await fixture(t), original = childProcess.spawn;
  let calls = 0;
  t.mock.method(childProcess, "spawn", function (command, args, options) {
    if (command === "git") {
      calls++;
      assert.equal(options.cwd, path.dirname(process.execPath));
      assert.equal(args[args.indexOf("-C") + 1], repo);
    }
    return original.call(this, command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const snapshot = await buildCatalog(repo), reader = await readerFor(base, repo, snapshot);
  await reader.call("search", { query: "owner" });
  await verifyObservations(snapshot);
  assert.ok(calls > 2);
});

test("a search page checks ignore policy in bounded batches rather than per file", async (t) => {
  const { base, repo } = await fixture(t);
  for (let i = 0; i < 32; i++) await fs.writeFile(path.join(repo, `file-${i}.js`), "owner\n");
  const snapshot = await buildCatalog(repo), reader = await readerFor(base, repo, snapshot);
  const calls = countGit(t);
  const result = await reader.call("search", { query: "absent" });
  assert.equal(result.scanned_files, 34);
  assert.equal(result.complete, true);
  assert.ok(calls() <= 5, `search launched ${calls()} Git processes`);
  assert.equal((await readObservations(snapshot)).entries.size, 34);
});

test("final verification checks the observed set with one Git batch", async (t) => {
  const { base, repo } = await fixture(t), snapshot = await buildCatalog(repo);
  const reader = await readerFor(base, repo, snapshot);
  await reader.call("search", { query: "absent" });
  const calls = countGit(t);
  assert.equal((await verifyObservations(snapshot)).consistency.verified_files, 2);
  assert.equal(calls(), 1);
});

test("a policy edit during a search cannot disclose an earlier match", async (t) => {
  const { base, repo } = await fixture(t), snapshot = await buildCatalog(repo);
  snapshot.journal = await createObservationJournal(path.join(base, "observations.jsonl"), snapshot, "test-run");
  const reader = await createRepositoryReader({ repo, snapshot, onObservation: async (relative, entry) => {
    await appendObservation(snapshot.journal, relative, entry);
    if (relative === "unrelated.js") await fs.writeFile(path.join(repo, ".gitignore"), "source.js\n");
  } });
  await assert.rejects(reader.call("search", { query: "owner" }), { code: "broker-path-denied" });
  await assert.rejects(verifyObservations(snapshot), { code: "observed-files-changed" });
});

test("bounded reads avoid an EOF round trip and still detect growth", async (t) => {
  const { repo } = await fixture(t), repository = await openRepository(repo), original = fs.open;
  let reads = 0, grow = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await original(...args);
    if (args[0] === path.join(repo, "source.js")) {
      const read = handle.read.bind(handle);
      handle.read = async (...params) => {
        reads++;
        const result = await read(...params);
        if (grow) { grow = false; await fs.appendFile(args[0], "growth\n"); }
        return result;
      };
    }
    return handle;
  });
  const entry = await repository.read("source.js", { collect: true });
  assert.equal(entry.contents.toString(), "export const owner = 1;\n");
  assert.equal(reads, 1);
  grow = true;
  await assert.rejects(repository.read("source.js"), { code: "repository-changed" });
});

test("ignore batches preserve nested, global, tracked, Unicode and literal path policies across boundaries", async (t) => {
  const { base, repo, git } = await fixture(t);
  await fs.mkdir(path.join(repo, "nested"));
  await fs.writeFile(path.join(repo, ".gitignore"), "source.js\n*.blocked\n");
  await fs.writeFile(path.join(repo, "nested", ".gitignore"), "!keep.blocked\n");
  const excludes = path.join(base, "global-ignore");
  await fs.writeFile(excludes, "global.js\n");
  git("config", "core.excludesFile", excludes);
  const candidates = [...Array.from({ length: 500 }, (_, i) => `file-${i}.js`),
    "source.js", "global.js", "папка с пробелом/файл.blocked", "--dash.blocked", "nested/keep.blocked"];
  const calls = countGit(t);
  const ignored = await currentIgnoredPaths(repo, candidates);
  assert.deepEqual([...ignored], ["source.js", "global.js", "папка с пробелом/файл.blocked", "--dash.blocked"]);
  assert.equal(calls(), 2);
  await fs.writeFile(excludes, "file-0.js\n");
  assert.deepEqual([...await currentIgnoredPaths(repo, ["file-0.js", "global.js"])], ["file-0.js"]);
  await assert.rejects(currentIgnoredPaths(repo, ["../outside"]), { code: "broker-path-denied" });
  await assert.rejects(currentIgnoredPaths(repo, ["source.js"], { deadline: Date.now() - 1 }), { code: "broker-policy-timeout" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(currentIgnoredPaths(repo, ["source.js"], { signal: controller.signal }), { code: "broker-policy-cancelled" });
  await fs.writeFile(path.join(repo, ".git", "config"), "invalid configuration [\n");
  await assert.rejects(currentIgnoredPaths(repo, ["source.js"]), { code: "broker-policy-unavailable" });
});

test("read bounds retain short-read, empty-file and truncation handling", async (t) => {
  const { repo } = await fixture(t), repository = await openRepository(repo), original = fs.open;
  await fs.writeFile(path.join(repo, "empty.js"), "");
  let truncate = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await original(...args);
    if (args[0] === path.join(repo, "source.js")) {
      const read = handle.read.bind(handle);
      handle.read = async (buffer, offset, length, position) => {
        const result = await read(buffer, offset, Math.min(3, length), position);
        if (truncate) { truncate = false; await fs.truncate(args[0], 0); }
        return result;
      };
    }
    return handle;
  });
  assert.equal((await repository.read("source.js", { collect: true })).contents.toString(), "export const owner = 1;\n");
  const empty = await repository.read("empty.js", { collect: true });
  assert.equal(empty.bytes, 0); assert.equal(empty.lines, 1); assert.equal(empty.contents.length, 0);
  truncate = true;
  await assert.rejects(repository.read("source.js"), { code: "repository-changed" });
});

test("a linked observed ancestor remains drift rather than a Git policy transport failure", async (t) => {
  const { base, repo } = await fixture(t);
  await fs.mkdir(path.join(repo, "nested"));
  await fs.writeFile(path.join(repo, "nested", "source.js"), "owner\n");
  const snapshot = await buildCatalog(repo), reader = await readerFor(base, repo, snapshot);
  await reader.call("read_lines", { path: "nested/source.js" });
  await fs.rename(path.join(repo, "nested"), path.join(base, "moved"));
  await fs.symlink(path.join(base, "moved"), path.join(repo, "nested"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyObservations(snapshot), { code: "observed-files-changed" });
});

test("resumed live pages refresh ignore policy", async (t) => {
  const { base, repo } = await fixture(t);
  await fs.writeFile(path.join(repo, "unrelated.js"), "owner second\n");
  const snapshot = await buildCatalog(repo), reader = await readerFor(base, repo, snapshot);
  const first = await reader.call("search", { query: "owner", limit: 1 });
  assert.equal(first.matches[0].path, "source.js");
  assert.ok(first.next_cursor);
  await fs.writeFile(path.join(repo, ".gitignore"), "unrelated.js\n");
  const second = await reader.call("search", { query: "owner", limit: 1, cursor: first.next_cursor });
  assert.deepEqual(second.matches, []);
  assert.equal(second.unreadable_reasons["broker-path-denied"], 1);
  await assert.rejects(verifyObservations(snapshot), { code: "observed-files-changed" });
});

test("slow metadata stops prefetching at the page deadline while preserving cursor progress", async (t) => {
  const { base, repo } = await fixture(t);
  for (let i = 0; i < 20; i++) await fs.writeFile(path.join(repo, `file-${i}.js`), "owner\n");
  const snapshot = await buildCatalog(repo), reader = await readerFor(base, repo, snapshot);
  const lstat = fs.lstat, inspected = new Set();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(fs, "lstat", async (file, ...args) => {
    const result = await lstat(file, ...args);
    if (String(file).endsWith(".js")) { now += 6000; inspected.add(file); }
    return result;
  });
  const page = await reader.call("search", { query: "absent" });
  assert.equal(page.scanned_files, 1);
  assert.equal(page.stop_reason, "scan-budget");
  assert.ok(page.next_cursor);
  assert.ok(inspected.size <= 4, `prefetched ${inspected.size} files after deadline`);
  const earlier = new Set(inspected);
  const resumed = await reader.call("search", { query: "absent", cursor: page.next_cursor });
  assert.equal(resumed.scanned_files, 1);
  assert.ok(resumed.next_cursor);
  assert.ok([...inspected].filter((file) => !earlier.has(file)).length <= 1);
});
