import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { computeFingerprint } from "../scripts/rg.mjs";
import { createRepositoryReader } from "../scripts/repository-reader.mjs";
import { serveRepositoryReader } from "../scripts/read-broker.mjs";

async function fixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "rg-broker-test-"));
  t.after(async () => {
    assert.equal(path.dirname(repo), path.resolve(os.tmpdir()));
    assert.match(path.basename(repo), /^rg-broker-test-/);
    await fs.rm(repo, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "--quiet", repo]);
  await fs.mkdir(path.join(repo, "папка с пробелом"));
  await fs.writeFile(path.join(repo, "папка с пробелом", "source.js"), "export function owner() {\n  return 1;\n}\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
  await fs.writeFile(path.join(repo, "ignored.txt"), "not evidence");
  await fs.writeFile(path.join(repo, ".env"), "FAKE_TEST_VALUE=do-not-return\n");
  return repo;
}

test("broker lists, searches and reads exact unicode paths without changing files", async (t) => {
  const repo = await fixture(t);
  const snapshot = await computeFingerprint(repo);
  const reader = await createRepositoryReader({ repo, snapshot });
  const listing = await reader.call("list_files", { contains: "source" });
  assert.deepEqual(listing.paths, ["папка с пробелом/source.js"]);
  const found = await reader.call("search", { query: "function owner" });
  assert.equal(found.matches[0].path, "папка с пробелом/source.js");
  assert.equal(found.matches[0].line, 1);
  const read = await reader.call("read_lines", { path: found.matches[0].path, line_start: 1, line_end: 2 });
  assert.equal(read.text, "export function owner() {\n  return 1;");
  assert.deepEqual((await computeFingerprint(repo)).public, snapshot.public);
});

test("broker rejects writes, arbitrary commands, traversal, secrets and ignored paths", async (t) => {
  const repo = await fixture(t);
  const reader = await createRepositoryReader({ repo, snapshot: await computeFingerprint(repo) });
  for (const tool of ["write_file", "exec", "delete", "__proto__"]) {
    await assert.rejects(reader.call(tool, {}), { code: "broker-invalid-request" });
  }
  for (const file of ["../source", ".env", "ignored.txt", "C:/outside", "//server/share", ".git/config", "source.js:stream", "a\\b"]) {
    await assert.rejects(reader.call("read_lines", { path: file, line_start: 1, line_end: 1 }), { code: "broker-path-denied" });
    await assert.rejects(reader.call("search", { query: "owner", path: file }), { code: "broker-path-denied" });
  }
  await assert.rejects(reader.call("list_files", { command: "anything" }), { code: "broker-invalid-request" });
  await assert.rejects(reader.call("search", { query: "x", limit: 100000 }), { code: "broker-invalid-request" });
  await assert.rejects(reader.call("read_lines", { path: "папка с пробелом/source.js", line_start: 1, line_end: 500 }), { code: "broker-invalid-request" });
});

test("broker pagination preserves filtered inventory positions and reports truncated matches", async (t) => {
  const repo = await fixture(t);
  await fs.writeFile(path.join(repo, "a.js"), "needle one\nneedle two\nneedle three\n");
  await fs.writeFile(path.join(repo, "b.txt"), "not selected\n");
  await fs.writeFile(path.join(repo, "c.js"), "needle four\n");
  const reader = await createRepositoryReader({ repo, snapshot: await computeFingerprint(repo) });
  const found = [];
  let cursor = 0;
  do {
    const page = await reader.call("list_files", { contains: ".js", cursor, limit: 1 });
    found.push(...page.paths);
    assert.ok(page.next_cursor === null || page.next_cursor > cursor);
    cursor = page.next_cursor;
  } while (cursor !== null);
  assert.deepEqual(found, ["a.js", "c.js", "папка с пробелом/source.js"]);
  const first = await reader.call("search", { query: "needle", limit: 1 });
  assert.equal(first.matches[0].path, "a.js");
  assert.equal(first.matches_truncated_in_last_file, true);
  const second = await reader.call("search", { query: "needle", cursor: first.next_cursor, limit: 1 });
  assert.equal(second.matches[0].path, "c.js");
  const remainder = await reader.call("read_lines", { path: "a.js", line_start: 2, line_end: 3 });
  assert.equal(remainder.text, "needle two\nneedle three");
  const last = await reader.call("list_files", { cursor: reader.paths.length });
  assert.deepEqual(last.paths, []);
  assert.equal(last.next_cursor, null);
  for (const invalid of [-1, 1.5, reader.paths.length + 1]) {
    await assert.rejects(reader.call("list_files", { cursor: invalid }), { code: "broker-invalid-request" });
    await assert.rejects(reader.call("search", { query: "needle", cursor: invalid }), { code: "broker-invalid-request" });
  }
});

test("broker refuses an inventory directory replaced by an external junction", async (t) => {
  const repo = await fixture(t);
  const outside = await fixture(t);
  const reader = await createRepositoryReader({ repo, snapshot: await computeFingerprint(repo) });
  const original = path.join(repo, "папка с пробелом");
  const moved = path.join(repo, "moved");
  assert.ok(original.startsWith(`${repo}${path.sep}`) && moved.startsWith(`${repo}${path.sep}`));
  await fs.rename(original, moved);
  await fs.symlink(path.join(outside, "папка с пробелом"), original, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(reader.call("read_lines", { path: "папка с пробелом/source.js" }), { code: "broker-path-denied" });
  const found = await reader.call("search", { query: "owner" });
  assert.deepEqual(found.matches, []);
});

test("broker refuses replacement of its repository root after initialization", async (t) => {
  const repo = await fixture(t);
  const reader = await createRepositoryReader({ repo, snapshot: await computeFingerprint(repo) });
  const moved = `${repo}-moved`;
  assert.equal(path.dirname(moved), path.resolve(os.tmpdir()));
  assert.match(path.basename(moved), /^rg-broker-test-[A-Za-z0-9]+-moved$/);
  await fs.rename(repo, moved);
  try {
    await fs.mkdir(repo);
    await assert.rejects(reader.call("list_files", {}), { code: "broker-path-denied" });
    await assert.rejects(reader.call("read_lines", { path: "папка с пробелом/source.js" }), { code: "broker-path-denied" });
  } finally {
    await fs.rmdir(repo);
    await fs.rename(moved, repo);
  }
});

test("broker refuses changed file bytes even when the path remains in inventory", async (t) => {
  const repo = await fixture(t);
  const reader = await createRepositoryReader({ repo, snapshot: await computeFingerprint(repo) });
  await fs.writeFile(path.join(repo, "папка с пробелом", "source.js"), "changed\n");
  await assert.rejects(reader.call("read_lines", { path: "папка с пробелом/source.js", line_start: 1, line_end: 1 }), { code: "broker-repository-changed" });
});

test("broker rejects symlink and hardlink evidence", async (t) => {
  const repo = await fixture(t);
  await fs.symlink(path.join(repo, "папка с пробелом"), path.join(repo, "linked"), process.platform === "win32" ? "junction" : "dir");
  await fs.link(path.join(repo, "папка с пробелом", "source.js"), path.join(repo, "hard.js"));
  const reader = await createRepositoryReader({ repo, snapshot: await computeFingerprint(repo) });
  await assert.rejects(reader.call("read_lines", { path: "linked/source.js", line_start: 1, line_end: 1 }), { code: "broker-path-denied" });
  await assert.rejects(reader.call("read_lines", { path: "hard.js", line_start: 1, line_end: 1 }), { code: "broker-path-denied" });
});

test("broker refuses a directory swapped for a junction after initialization", async (t) => {
  const repo = await fixture(t);
  const reader = await createRepositoryReader({ repo, snapshot: await computeFingerprint(repo) });
  const original = path.join(repo, "папка с пробелом");
  const moved = path.join(repo, "moved");
  await fs.rename(original, moved);
  await fs.symlink(moved, original, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(reader.call("read_lines", { path: "папка с пробелом/source.js", line_start: 1, line_end: 1 }), { code: "broker-path-denied" });
});

test("broker rejects tracked ignored files and bounds oversized responses", async (t) => {
  const repo = await fixture(t);
  execFileSync("git", ["-C", repo, "add", "-f", "ignored.txt"]);
  await fs.writeFile(path.join(repo, "large-line.js"), "x".repeat(50 * 1024));
  const reader = await createRepositoryReader({ repo, snapshot: await computeFingerprint(repo) });
  assert.equal(reader.paths.includes("ignored.txt"), false);
  await assert.rejects(reader.call("read_lines", { path: "ignored.txt" }), { code: "broker-path-denied" });
  await assert.rejects(reader.call("read_lines", { path: "large-line.js", line_start: 1, line_end: 1 }), { code: "broker-output-limit" });
});

test("stdio protocol preserves split UTF-8 and exposes only the three read tools", async (t) => {
  const repo = await fixture(t);
  const reader = await createRepositoryReader({ repo, snapshot: await computeFingerprint(repo) });
  const messages = [null,
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_lines", arguments: { path: "папка с пробелом/source.js", line_start: 1, line_end: 1 } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "write_file", arguments: {} } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  const bytes = Buffer.from(messages);
  const split = bytes.indexOf(Buffer.from("папка")) + 1;
  let output = "";
  await serveRepositoryReader(reader, Readable.from([bytes.subarray(0, split), bytes.subarray(split)]), new Writable({
    write(chunk, _encoding, done) { output += chunk.toString("utf8"); done(); },
  }));
  const replies = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies[0].error.code, -32600);
  assert.deepEqual(replies.find((reply) => reply.id === 2).result.tools.map((tool) => tool.name), ["list_files", "search", "read_lines"]);
  assert.equal(JSON.parse(replies.find((reply) => reply.id === 3).result.content[0].text).path, "папка с пробелом/source.js");
  assert.equal(replies.find((reply) => reply.id === 4).result.isError, true);
});

test("stdio rejects oversized requests before dispatching any tool", async () => {
  await assert.rejects(serveRepositoryReader({ call() { assert.fail("must not dispatch"); } },
    Readable.from([Buffer.alloc(64 * 1024 + 1, 120)]), new Writable({ write(_chunk, _encoding, done) { done(); } })), /broker-input-limit/);
});
