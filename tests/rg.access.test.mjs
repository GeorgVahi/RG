import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { probeSandboxAccess } from "../scripts/access.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rg-access-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^rg-access-test-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "source.js"), "export const owner = 1;\n");
  return root;
}

function sandboxExecutor(transform = (value) => value) {
  return (_bin, args, options) => {
    const separator = args.indexOf("--");
    assert.ok(separator > 0);
    assert.ok(args.includes("--include-managed-config"));
    assert.ok(args.includes(":read-only"));
    const result = spawnSync(args[separator + 1], args.slice(separator + 2), options);
    return transform(result);
  };
}

test("sandbox preflight proves the child reads the same bytes at the intended cwd", async (t) => {
  const repo = await fixture(t);
  const result = await probeSandboxAccess({ repo, sample: "source.js", execute: sandboxExecutor() });
  assert.equal(result.status, "ok");
  assert.equal(result.checks.parent_read, "ok");
  assert.equal(result.checks.sandbox_read, "ok");
  assert.equal(result.checks.cwd, "ok");
});

test("parent readability never turns a sandbox denial into success", async (t) => {
  const repo = await fixture(t);
  const result = await probeSandboxAccess({ repo, sample: "source.js", execute: () => ({
    status: 1, stdout: JSON.stringify({ schema: "rg.sandbox-probe.v1", error: "EACCES" }), stderr: "",
  }) });
  assert.equal(result.status, "failed");
  assert.equal(result.failure_reason, "sandbox-read-denied");
  assert.equal(result.checks.parent_read, "ok");
});

test("a successful process with wrong cwd or bytes fails closed", async (t) => {
  const repo = await fixture(t);
  for (const [field, value, reason] of [
    ["cwd", path.dirname(repo), "cwd-mismatch"],
    ["sha256", "0".repeat(64), "sandbox-read-mismatch"],
  ]) {
    const result = await probeSandboxAccess({ repo, sample: "source.js", execute: sandboxExecutor((outcome) => {
      const payload = JSON.parse(outcome.stdout);
      payload[field] = value;
      return { ...outcome, stdout: JSON.stringify(payload) };
    }) });
    assert.equal(result.failure_reason, reason);
  }
});

test("unsupported sandbox, timeout and malformed output are explicit failures", async (t) => {
  const repo = await fixture(t);
  for (const [outcome, reason] of [
    [{ status: 1, stdout: "", stderr: "unexpected argument --permission-profile" }, "sandbox-probe-unavailable"],
    [{ status: null, error: { code: "ETIMEDOUT" } }, "sandbox-probe-timeout"],
    [{ status: 0, stdout: "not JSON" }, "sandbox-probe-invalid"],
  ]) {
    const result = await probeSandboxAccess({ repo, sample: "source.js", execute: () => outcome });
    assert.equal(result.status, "failed");
    assert.equal(result.failure_reason, reason);
  }
});

test("preflight rejects paths outside the repository before spawning", async (t) => {
  const repo = await fixture(t);
  for (const sample of ["../secret", "/secret", "C:/secret", "a/../../secret"]) {
    const result = await probeSandboxAccess({ repo, sample, execute: () => assert.fail("must not spawn") });
    assert.equal(result.failure_reason, "sandbox-probe-invalid-sample");
  }
});
