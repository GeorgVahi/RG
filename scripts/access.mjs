import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

// The probe runs inside the same read-only policy as the scout. Only a bounded
// digest leaves the sandbox; file contents and exception text are never logged.
const PROBE = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
let fd;
try {
  fd = fs.openSync(path.join(input.repo, input.sample), "r");
  const buffer = Buffer.alloc(4096);
  const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
  console.log(JSON.stringify({schema:"rg.sandbox-probe.v1", nonce:input.nonce,
    cwd:fs.realpathSync.native(process.cwd()), bytes,
    sha256:crypto.createHash("sha256").update(buffer.subarray(0, bytes)).digest("hex")}));
} catch (error) {
  console.log(JSON.stringify({schema:"rg.sandbox-probe.v1", error:error.code || "UNKNOWN"}));
  process.exitCode = 1;
} finally { if (fd !== undefined) fs.closeSync(fd); }
`;

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function probeSandboxAccess({
  repo, sample, codexBin = "codex", codexArgsPrefix = [], environment = process.env,
  execute = spawnSync, timeoutMs = 20_000,
}) {
  const checks = { parent_read: "not_checked", sandbox_read: "not_checked", cwd: "not_checked" };
  const fail = (failure_reason) => ({ schema: "rg.access.v1", transport: "native", status: "failed", checks, failure_reason });
  if (typeof sample !== "string" || !sample || sample.includes("\\") || sample.includes("\0") ||
      sample.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":")) ||
      path.posix.isAbsolute(sample) || path.win32.isAbsolute(sample)) {
    return fail("sandbox-probe-invalid-sample");
  }
  let root, expected;
  try {
    root = fs.realpathSync.native(repo);
    let current = root;
    for (const component of sample.split("/")) {
      current = path.join(current, component);
      if (fs.lstatSync(current).isSymbolicLink()) return fail("sandbox-probe-invalid-sample");
    }
    if (!fs.statSync(current).isFile()) return fail("sandbox-probe-invalid-sample");
    const fd = fs.openSync(current, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      expected = { bytes, sha256: createHash("sha256").update(buffer.subarray(0, bytes)).digest("hex") };
    } finally { fs.closeSync(fd); }
    checks.parent_read = "ok";
  } catch {
    checks.parent_read = "failed";
    return fail("repository-read-unavailable");
  }
  const nonce = randomBytes(16).toString("hex");
  const payload = Buffer.from(JSON.stringify({ repo: root, sample, nonce })).toString("base64");
  const args = [...codexArgsPrefix, "sandbox", "--include-managed-config", "--permission-profile", ":read-only",
    "-c", 'approval_policy="never"', "-C", root, "--", process.execPath, "-e", PROBE, payload];
  let outcome;
  try {
    outcome = execute(codexBin, args, {
      cwd: root, env: environment, encoding: "utf8", windowsHide: true,
      timeout: timeoutMs, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch { return fail("sandbox-probe-unavailable"); }
  if (outcome.error?.code === "ETIMEDOUT") return fail("sandbox-probe-timeout");
  if (outcome.error) return fail("sandbox-probe-unavailable");
  let observed;
  try { observed = JSON.parse(outcome.stdout); } catch {
    return fail(outcome.status === 0 ? "sandbox-probe-invalid" : "sandbox-probe-unavailable");
  }
  if (observed?.schema !== "rg.sandbox-probe.v1") return fail("sandbox-probe-invalid");
  if (outcome.status !== 0) {
    checks.sandbox_read = "failed";
    return fail(["EACCES", "EPERM"].includes(observed.error) ? "sandbox-read-denied" : "sandbox-read-unavailable");
  }
  if (observed.nonce !== nonce) return fail("sandbox-probe-invalid");
  if (!samePath(observed.cwd, root)) {
    checks.cwd = "failed";
    return fail("cwd-mismatch");
  }
  checks.cwd = "ok";
  if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) {
    checks.sandbox_read = "failed";
    return fail("sandbox-read-mismatch");
  }
  checks.sandbox_read = "ok";
  return { schema: "rg.access.v1", transport: "native", status: "ok", checks };
}
