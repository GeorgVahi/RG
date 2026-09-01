import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RGError,
  assertRunStoreOutsideRepo,
  buildCodexArgs,
  buildPathPreflight,
  buildSearchPrompt,
  canonicalJson,
  computeFingerprint,
  createRunDirectory,
  developerInstructions,
  executeResolvedRoute,
  extractTriggers,
  failureResult,
  fingerprintDriftError,
  inspectRunStatus,
  maintainRunStore,
  readAndValidateResult,
  rgSkillDisablePaths,
  runningProgress,
  sameModelRepairDecision,
  scrubEnvironment,
  startRunLease,
  validateModelMap,
  validateProfile,
  validateResultObject,
  validateSubscriptionConfig,
} from "../scripts/rg.mjs";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-"));
  execFileSync("git", ["init", "--quiet", directory]);
  await fs.writeFile(path.join(directory, "source.js"), "export function owner() {\n  return 1;\n}\n");
  return directory;
}

async function dispose(directory) {
  const resolved = path.resolve(directory);
  assert.equal(path.basename(resolved).startsWith("rg-test-"), true);
  await fs.rm(resolved, { recursive: true, force: true });
}

function discovery(snapshot) {
  return {
    schema: "rg.discovery.v1",
    worktree_fingerprint: snapshot.public,
    summary: "The exported function owns the fixture behavior.",
    owners: [
      {
        path: "source.js",
        line_start: 1,
        line_end: 3,
        symbol: "owner",
        reason: "The function directly owns the behavior under search.",
        kind: "implementation",
        related_path: null,
      },
    ],
    couplings: [],
    tests: [],
    flows: [],
    constraints: [],
    uncertainties: [],
  };
}

function syntheticSnapshot(publicDigit, entryDigit = publicDigit) {
  return {
    public: {
      algorithm: "sha256",
      digest: publicDigit.repeat(64),
      files: 1,
      bytes: 1,
      inventory: "git-tracked-untracked-nonignored-v1",
    },
    paths: new Set(["source.js"]),
    lineCounts: new Map([["source.js", 1]]),
    entries: new Map([
      [
        "source.js",
        { kind: "file", bytes: 1, lines: 1, digest: entryDigit.repeat(64) },
      ],
    ]),
  };
}

test("canonical JSON is stable across object key order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

test("CLI entrypoint runs when the skill directory is reached through a link", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-link-"));
  const linked = path.join(directory, "rg");
  const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  try {
    await fs.symlink(repository, linked, process.platform === "win32" ? "junction" : "dir");
    const result = spawnSync(
      process.execPath,
      [path.join(linked, "scripts", "rg.mjs"), "help"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RG exact-model repository search/);
  } finally {
    try {
      await fs.unlink(linked);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await dispose(directory);
  }
});

test("fingerprint is stable and detects worktree content changes", async () => {
  const directory = await fixture();
  try {
    const first = await computeFingerprint(directory);
    const second = await computeFingerprint(directory);
    assert.deepEqual(first.public, second.public);
    await fs.appendFile(path.join(directory, "source.js"), "// changed\n");
    const changed = await computeFingerprint(directory);
    assert.notEqual(first.public.digest, changed.public.digest);
  } finally {
    await dispose(directory);
  }
});

test("fingerprint drift diagnostics are bounded and classify changed paths", async () => {
  const directory = await fixture();
  try {
    const before = await computeFingerprint(directory);
    await fs.appendFile(path.join(directory, "source.js"), "// drift\n");
    await fs.writeFile(path.join(directory, "added.js"), "export const added = true;\n");
    const after = await computeFingerprint(directory);
    const error = fingerprintDriftError(
      "worktree drifted",
      "during-search",
      before,
      after,
    );
    const observed = failureResult(error);
    assert.equal(observed.failure_reason, "fingerprint-drift");
    assert.equal(observed.fingerprint_drift.schema, "rg.fingerprint-drift.v1");
    assert.equal(observed.fingerprint_drift.phase, "during-search");
    assert.equal(observed.fingerprint_drift.changes.added, 1);
    assert.equal(observed.fingerprint_drift.changes.modified, 1);
    assert.equal(observed.fingerprint_drift.changes.total, 2);
    assert.deepEqual(observed.fingerprint_drift.changes.paths, [
      { path: "added.js", change: "added" },
      { path: "source.js", change: "modified" },
    ]);
  } finally {
    await dispose(directory);
  }
});

test("run artifacts cannot become self-induced repository drift", () => {
  const repo = path.resolve("C:/bounded/repository");
  assert.throws(
    () => assertRunStoreOutsideRepo(repo, path.join(repo, ".codex-home")),
    (error) => error instanceof RGError && error.code === "invalid-configuration",
  );
  assert.doesNotThrow(() =>
    assertRunStoreOutsideRepo(repo, path.resolve("C:/bounded/codex-home")),
  );
});

test("run status never turns polling windows into failure and only permits fallback for terminal failure", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-status-"));
  const nowMs = Date.now();
  const runsRoot = path.join(home, "rg", "runs");
  const ids = {
    active: "20200101000000000-rg_search_fast-aaaaaaaaaaaa",
    completed: "20200101000000001-rg_search_fast-bbbbbbbbbbbb",
    failed: "20200101000000002-rg_search_fast-cccccccccccc",
    stale: "20200101000000003-rg_search_fast-dddddddddddd",
    invalid: "20200101000000004-rg_search_fast-eeeeeeeeeeee",
    missing: "20200101000000005-rg_search_fast-ffffffffffff",
  };
  const writeRun = async (runId, receipt) => {
    const runDirectory = path.join(runsRoot, runId);
    await fs.mkdir(runDirectory, { recursive: true });
    const receiptPath = path.join(runDirectory, "receipt.json");
    await fs.writeFile(
      receiptPath,
      `${JSON.stringify({ schema: "rg.receipt.v1", run_id: runId, ...receipt })}\n`,
    );
    return { runDirectory, receiptPath };
  };

  try {
    const active = await writeRun(ids.active, {
      status: "running",
      started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
      completed_at: null,
      result_evidence: "missing",
    });
    await fs.writeFile(
      path.join(active.runDirectory, "active.json"),
      `${JSON.stringify({
        schema: "rg.active.v1",
        run_id: ids.active,
        pid: process.pid,
        started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
      })}\n`,
    );
    await writeRun(ids.completed, {
      status: "completed",
      started_at: new Date(nowMs - 2 * 60 * 1000).toISOString(),
      completed_at: new Date(nowMs - 60 * 1000).toISOString(),
      terminal_event: "turn.completed",
      codex_exit_code: 0,
      result_evidence: "valid",
    });
    await writeRun(ids.failed, {
      status: "failed",
      started_at: new Date(nowMs - 2 * 60 * 1000).toISOString(),
      completed_at: new Date(nowMs - 60 * 1000).toISOString(),
      failure_reason: "runner-failed",
    });
    await writeRun(ids.stale, {
      status: "running",
      started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
      completed_at: null,
    });
    await writeRun(ids.invalid, {
      status: "completed",
      started_at: new Date(nowMs - 2 * 60 * 1000).toISOString(),
      completed_at: new Date(nowMs - 60 * 1000).toISOString(),
      terminal_event: "turn.completed",
      codex_exit_code: 0,
      result_evidence: "missing",
    });

    for (let pollingWindow = 0; pollingWindow < 3; pollingWindow += 1) {
      const status = await inspectRunStatus({
        home,
        runId: ids.active,
        nowMs: nowMs + pollingWindow * 30_000,
      });
      assert.equal(status.schema, "rg.status.v1");
      assert.equal(status.state, "running_active");
      assert.equal(status.terminal, false);
      assert.equal(status.fallback_allowed, false);
      assert.equal(status.polling_windows_affect_state, false);
      assert.equal(status.action, "wait");
    }

    const byReceipt = await inspectRunStatus({ home, receipt: active.receiptPath, nowMs });
    assert.equal(byReceipt.state, "running_active");

    const completed = await inspectRunStatus({ home, runId: ids.completed, nowMs });
    assert.equal(completed.state, "completed");
    assert.equal(completed.terminal, true);
    assert.equal(completed.fallback_allowed, false);
    assert.equal(completed.action, "consume-result");
    assert.equal(completed.elapsed_ms, 60_000);

    const failed = await inspectRunStatus({ home, runId: ids.failed, nowMs });
    assert.equal(failed.state, "failed");
    assert.equal(failed.terminal, true);
    assert.equal(failed.fallback_allowed, true);
    assert.equal(failed.action, "minimum-targeted-recovery");
    assert.equal(failed.elapsed_ms, 60_000);

    const stale = await inspectRunStatus({ home, runId: ids.stale, nowMs });
    assert.equal(stale.state, "running_stale");
    assert.equal(stale.terminal, false);
    assert.equal(stale.fallback_allowed, false);

    const invalid = await inspectRunStatus({ home, runId: ids.invalid, nowMs });
    assert.equal(invalid.state, "invalid");
    assert.equal(invalid.fallback_allowed, false);

    const missing = await inspectRunStatus({ home, runId: ids.missing, nowMs });
    assert.equal(missing.state, "not_found");
    assert.equal(missing.fallback_allowed, false);

    const cli = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/rg.mjs", import.meta.url)), "status", "--run-id", ids.active],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: home },
        windowsHide: true,
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const cliStatus = JSON.parse(cli.stdout);
    assert.equal(cliStatus.schema, "rg.status.v1");
    assert.equal(cliStatus.state, "running_active");
    assert.equal(cliStatus.fallback_allowed, false);

    const invalidCli = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/rg.mjs", import.meta.url)), "status", "--run-id", "bad"],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: home },
        windowsHide: true,
      },
    );
    assert.equal(invalidCli.status, 1);
    const invalidCliStatus = JSON.parse(invalidCli.stdout);
    assert.equal(invalidCliStatus.schema, "rg.status.v1");
    assert.equal(invalidCliStatus.state, "invalid");
    assert.equal(invalidCliStatus.terminal, false);
    assert.equal(invalidCliStatus.fallback_allowed, false);

    await assert.rejects(
      inspectRunStatus({ home, runId: ids.active, receipt: active.receiptPath, nowMs }),
      (error) => error instanceof RGError && error.code === "invalid-arguments",
    );
    await assert.rejects(
      inspectRunStatus({ home, receipt: path.join(home, "outside", ids.active, "receipt.json"), nowMs }),
      (error) => error instanceof RGError && error.code === "invalid-arguments",
    );
  } finally {
    await dispose(home);
  }
});

test("run lease emits machine-readable nonterminal heartbeat progress", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-heartbeat-"));
  const runId = "20200101000000000-rg_search_fast-aaaaaaaaaaaa";
  const runDirectory = path.join(home, runId);
  await fs.mkdir(runDirectory);
  let resolveHeartbeat;
  const heartbeat = new Promise((resolve) => {
    resolveHeartbeat = resolve;
  });
  let lease;
  try {
    const startedMs = Date.now();
    lease = await startRunLease(runDirectory, runId, async () => {}, {
      heartbeatIntervalMs: 10,
      onHeartbeat: (nowMs) => resolveHeartbeat(runningProgress(runId, startedMs, nowMs)),
    });
    const progress = await Promise.race([
      heartbeat,
      new Promise((_, reject) => setTimeout(() => reject(new Error("heartbeat timeout")), 1000)),
    ]);
    assert.deepEqual(
      {
        schema: progress.schema,
        state: progress.state,
        run_id: progress.run_id,
        terminal: progress.terminal,
        fallback_allowed: progress.fallback_allowed,
        polling_windows_affect_state: progress.polling_windows_affect_state,
      },
      {
        schema: "rg.progress.v1",
        state: "running",
        run_id: runId,
        terminal: false,
        fallback_allowed: false,
        polling_windows_affect_state: false,
      },
    );
    assert.equal((await fs.stat(path.join(runDirectory, "active.json"))).isFile(), true);
  } finally {
    if (lease) await lease.stop();
    await assert.rejects(fs.stat(path.join(runDirectory, "active.json")), { code: "ENOENT" });
    await dispose(home);
  }
});

test("run-store maintenance reconciles stale receipts and deletes only eligible terminal runs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-store-"));
  let linkedRun;
  const nowMs = Date.now();
  const runsRoot = path.join(home, "rg", "runs");
  const ids = {
    stale: "20200101000000000-rg_search_fast-aaaaaaaaaaaa",
    active: "20200101000000001-rg_search_fast-bbbbbbbbbbbb",
    old: "20200101000000002-rg_search_fast-cccccccccccc",
    overflow: "20200101000000003-rg_search_fast-dddddddddddd",
    fresh: "20200101000000004-rg_search_fast-eeeeeeeeeeee",
    badRunning: "20200101000000006-rg_search_fast-111111111111",
    badTerminal: "20200101000000007-rg_search_fast-222222222222",
  };
  const writeRun = async (runId, receipt) => {
    const runDirectory = path.join(runsRoot, runId);
    await fs.mkdir(runDirectory, { recursive: true });
    await fs.writeFile(
      path.join(runDirectory, "receipt.json"),
      `${JSON.stringify({ schema: "rg.receipt.v1", run_id: runId, ...receipt })}\n`,
    );
    return runDirectory;
  };
  try {
    const staleDirectory = await writeRun(ids.stale, {
      status: "running",
      started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
      completed_at: null,
      result_evidence: "missing",
    });
    const activeDirectory = await writeRun(ids.active, {
      status: "running",
      started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
      completed_at: null,
      result_evidence: "missing",
    });
    await fs.writeFile(
      path.join(activeDirectory, "active.json"),
      `${JSON.stringify({
        schema: "rg.active.v1",
        run_id: ids.active,
        pid: process.pid,
        started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
      })}\n`,
    );
    const oldDirectory = await writeRun(ids.old, {
      status: "completed",
      started_at: new Date(nowMs - 31 * 24 * 60 * 60 * 1000).toISOString(),
      completed_at: new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const overflowDirectory = await writeRun(ids.overflow, {
      status: "failed",
      started_at: new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString(),
      completed_at: new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await writeRun(ids.fresh, {
      status: "completed",
      started_at: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
      completed_at: new Date(nowMs - 60 * 60 * 1000).toISOString(),
    });
    await fs.mkdir(path.join(runsRoot, "not-an-rg-run"));
    const badRunningDirectory = await writeRun(ids.badRunning, {
      status: "running",
      started_at: "not-a-date",
      completed_at: null,
    });
    const badTerminalDirectory = await writeRun(ids.badTerminal, {
      status: "completed",
      started_at: "2020-01-01T00:00:00.000Z",
      completed_at: "not-a-date",
    });
    const oldDirectoryTime = new Date(nowMs - 60 * 24 * 60 * 60 * 1000);
    await fs.utimes(badTerminalDirectory, oldDirectoryTime, oldDirectoryTime);
    const linkedTarget = path.join(home, "linked-run-target");
    linkedRun = path.join(
      runsRoot,
      "20200101000000005-rg_search_fast-ffffffffffff",
    );
    await fs.mkdir(linkedTarget);
    await fs.writeFile(path.join(linkedTarget, "marker.txt"), "preserve\n");
    await fs.symlink(
      linkedTarget,
      linkedRun,
      process.platform === "win32" ? "junction" : "dir",
    );

    const options = {
      nowMs,
      staleRunMs: 2 * 60 * 60 * 1000,
      retentionMs: 14 * 24 * 60 * 60 * 1000,
      countCleanupMinAgeMs: 24 * 60 * 60 * 1000,
      maxRetainedRuns: 1,
    };
    const observed = await maintainRunStore(home, { ...options, mutate: false });
    assert.deepEqual(observed, {
      schema: "rg.run-store.v1",
      scanned: 5,
      running: 2,
      completed: 2,
      failed: 1,
      active_leases: 1,
      stale_running: 1,
      reconciled: 0,
      cleanup_eligible: 2,
      deleted: 0,
      invalid_entries: 4,
    });
    assert.equal(
      JSON.parse(await fs.readFile(path.join(staleDirectory, "receipt.json"), "utf8")).status,
      "running",
    );

    const maintained = await maintainRunStore(home, options);
    assert.equal(maintained.reconciled, 1);
    assert.equal(maintained.deleted, 2);
    assert.equal(maintained.running, 1);
    assert.equal(maintained.completed, 1);
    assert.equal(maintained.failed, 1);
    const reconciled = JSON.parse(
      await fs.readFile(path.join(staleDirectory, "receipt.json"), "utf8"),
    );
    assert.equal(reconciled.status, "failed");
    assert.equal(reconciled.failure_reason, "stale-run-reconciled");
    assert.equal(reconciled.lifecycle.terminalized_by, "run-store-maintenance");
    assert.equal(
      JSON.parse(await fs.readFile(path.join(activeDirectory, "receipt.json"), "utf8")).status,
      "running",
    );
    await assert.rejects(fs.stat(oldDirectory), { code: "ENOENT" });
    await assert.rejects(fs.stat(overflowDirectory), { code: "ENOENT" });
    assert.equal((await fs.stat(path.join(runsRoot, "not-an-rg-run"))).isDirectory(), true);
    assert.equal(await fs.readFile(path.join(linkedTarget, "marker.txt"), "utf8"), "preserve\n");
    assert.equal((await fs.stat(badTerminalDirectory)).isDirectory(), true);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(badRunningDirectory, "receipt.json"), "utf8")).status,
      "running",
    );
  } finally {
    if (linkedRun) await fs.unlink(linkedRun).catch(() => {});
    await dispose(home);
  }
});

test("run-store maintenance rejects a linked runs root without touching its target", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-store-root-"));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-store-target-"));
  const linkedRoot = path.join(home, "rg", "runs");
  const runId = "20200101000000000-rg_search_fast-aaaaaaaaaaaa";
  const targetRun = path.join(target, runId);
  await fs.mkdir(path.dirname(linkedRoot), { recursive: true });
  await fs.mkdir(targetRun);
  await fs.writeFile(
    path.join(targetRun, "receipt.json"),
    `${JSON.stringify({
      schema: "rg.receipt.v1",
      run_id: runId,
      status: "completed",
      started_at: "2020-01-01T00:00:00.000Z",
      completed_at: "2020-01-01T00:01:00.000Z",
    })}\n`,
  );
  await fs.symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  try {
    await assert.rejects(
      maintainRunStore(home, { nowMs: Date.parse("2020-02-01T00:00:00.000Z") }),
      (error) => error instanceof RGError && error.code === "run-store-invalid",
    );
    assert.equal((await fs.stat(targetRun)).isDirectory(), true);
    assert.equal((await fs.stat(path.join(targetRun, "receipt.json"))).isFile(), true);
  } finally {
    await fs.unlink(linkedRoot).catch(() => {});
    await dispose(home);
    await dispose(target);
  }
});

test("run-store maintenance rejects a linked rg parent without touching its target", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-store-parent-"));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-store-parent-target-"));
  const linkedParent = path.join(home, "rg");
  const runId = "20200101000000000-rg_search_fast-aaaaaaaaaaaa";
  const targetRun = path.join(target, "runs", runId);
  await fs.mkdir(targetRun, { recursive: true });
  await fs.writeFile(
    path.join(targetRun, "receipt.json"),
    `${JSON.stringify({
      schema: "rg.receipt.v1",
      run_id: runId,
      status: "completed",
      started_at: "2020-01-01T00:00:00.000Z",
      completed_at: "2020-01-01T00:01:00.000Z",
    })}\n`,
  );
  await fs.symlink(target, linkedParent, process.platform === "win32" ? "junction" : "dir");
  try {
    await assert.rejects(
      maintainRunStore(home, { nowMs: Date.parse("2020-02-01T00:00:00.000Z") }),
      (error) => error instanceof RGError && error.code === "run-store-invalid",
    );
    assert.equal((await fs.stat(targetRun)).isDirectory(), true);
    assert.equal((await fs.stat(path.join(targetRun, "receipt.json"))).isFile(), true);
  } finally {
    await fs.unlink(linkedParent).catch(() => {});
    await dispose(home);
    await dispose(target);
  }
});

test("run creation rechecks the store boundary after maintenance", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-create-boundary-"));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-create-target-"));
  const rgRoot = path.join(home, "rg");
  const displaced = path.join(home, "rg-original");
  const runId = "20200101000000000-rg_search_fast-aaaaaaaaaaaa";
  try {
    await maintainRunStore(home);
    await fs.rename(rgRoot, displaced);
    await fs.symlink(target, rgRoot, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      createRunDirectory(home, runId),
      (error) => error instanceof RGError && error.code === "run-store-invalid",
    );
    await assert.rejects(fs.stat(path.join(target, "runs", runId)), { code: "ENOENT" });
  } finally {
    await fs.unlink(rgRoot).catch(() => {});
    await fs.rename(displaced, rgRoot).catch(() => {});
    await dispose(home);
    await dispose(target);
  }
});

test("future-dated heartbeat without a live pid does not mask a stale run", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-store-future-"));
  const nowMs = Date.now();
  const runId = "20200101000000000-rg_search_fast-aaaaaaaaaaaa";
  const runDirectory = path.join(home, "rg", "runs", runId);
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(
    path.join(runDirectory, "receipt.json"),
    `${JSON.stringify({
      schema: "rg.receipt.v1",
      run_id: runId,
      status: "running",
      started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
      completed_at: null,
      result_evidence: "missing",
    })}\n`,
  );
  const activeFile = path.join(runDirectory, "active.json");
  await fs.writeFile(
    activeFile,
    `${JSON.stringify({
      schema: "rg.active.v1",
      run_id: runId,
      pid: -1,
      started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
    })}\n`,
  );
  const future = new Date(nowMs + 365 * 24 * 60 * 60 * 1000);
  await fs.utimes(activeFile, future, future);
  try {
    const reports = await Promise.all(
      Array.from({ length: 4 }, () =>
        maintainRunStore(home, {
          nowMs,
          staleRunMs: 2 * 60 * 60 * 1000,
          retentionMs: 14 * 24 * 60 * 60 * 1000,
        }),
      ),
    );
    assert.equal(reports.every((report) => report.active_leases === 0), true);
    assert.equal(
      reports.reduce((total, report) => total + report.reconciled, 0),
      1,
    );
    const receipt = JSON.parse(await fs.readFile(path.join(runDirectory, "receipt.json"), "utf8"));
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.failure_reason, "stale-run-reconciled");
  } finally {
    await dispose(home);
  }
});

test("malformed live-pid lease does not mask a stale run", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-store-bad-lease-"));
  const nowMs = Date.now();
  const runId = "20200101000000000-rg_search_fast-aaaaaaaaaaaa";
  const runDirectory = path.join(home, "rg", "runs", runId);
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(
    path.join(runDirectory, "receipt.json"),
    `${JSON.stringify({
      schema: "rg.receipt.v1",
      run_id: runId,
      status: "running",
      started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
      completed_at: null,
    })}\n`,
  );
  await fs.writeFile(
    path.join(runDirectory, "active.json"),
    `${JSON.stringify({
      schema: "wrong",
      run_id: "other-run",
      pid: process.pid,
      started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
    })}\n`,
  );
  try {
    const report = await maintainRunStore(home, { nowMs, staleRunMs: 2 * 60 * 60 * 1000 });
    assert.equal(report.active_leases, 0);
    assert.equal(report.reconciled, 1);
    const receipt = JSON.parse(await fs.readFile(path.join(runDirectory, "receipt.json"), "utf8"));
    assert.equal(receipt.status, "failed");
  } finally {
    await dispose(home);
  }
});

test("future heartbeat mtime needs a valid live owner rather than freshness alone", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-store-future-live-"));
  const nowMs = Date.now();
  const runId = "20200101000000000-rg_search_fast-aaaaaaaaaaaa";
  const runDirectory = path.join(home, "rg", "runs", runId);
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(
    path.join(runDirectory, "receipt.json"),
    `${JSON.stringify({
      schema: "rg.receipt.v1",
      run_id: runId,
      status: "running",
      started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
      completed_at: null,
    })}\n`,
  );
  const activeFile = path.join(runDirectory, "active.json");
  await fs.writeFile(
    activeFile,
    `${JSON.stringify({
      schema: "rg.active.v1",
      run_id: runId,
      pid: process.pid,
      started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
    })}\n`,
  );
  const future = new Date(nowMs + 365 * 24 * 60 * 60 * 1000);
  await fs.utimes(activeFile, future, future);
  try {
    const report = await maintainRunStore(home, { nowMs, staleRunMs: 2 * 60 * 60 * 1000 });
    assert.equal(report.active_leases, 1);
    assert.equal(report.reconciled, 0);
    const receipt = JSON.parse(await fs.readFile(path.join(runDirectory, "receipt.json"), "utf8"));
    assert.equal(receipt.status, "running");
  } finally {
    await dispose(home);
  }
});

test("malformed stale maintenance claims cannot borrow a live pid", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-store-bad-claim-"));
  const nowMs = Date.now();
  const runningId = "20200101000000000-rg_search_fast-aaaaaaaaaaaa";
  const terminalId = "20200101000000001-rg_search_fast-bbbbbbbbbbbb";
  const writeRun = async (runId, receipt) => {
    const runDirectory = path.join(home, "rg", "runs", runId);
    await fs.mkdir(runDirectory, { recursive: true });
    await fs.writeFile(
      path.join(runDirectory, "receipt.json"),
      `${JSON.stringify({ schema: "rg.receipt.v1", run_id: runId, ...receipt })}\n`,
    );
    const claimFile = path.join(runDirectory, ".maintenance.json");
    await fs.writeFile(
      claimFile,
      `${JSON.stringify({
        schema: "wrong",
        run_id: "other-run",
        claim_id: "not-a-valid-claim",
        pid: process.pid,
        claimed_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
      })}\n`,
    );
    const stale = new Date(nowMs - 3 * 60 * 60 * 1000);
    await fs.utimes(claimFile, stale, stale);
    return runDirectory;
  };
  const runningDirectory = await writeRun(runningId, {
    status: "running",
    started_at: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
    completed_at: null,
  });
  const terminalDirectory = await writeRun(terminalId, {
    status: "completed",
    started_at: new Date(nowMs - 31 * 24 * 60 * 60 * 1000).toISOString(),
    completed_at: new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  try {
    const report = await maintainRunStore(home, {
      nowMs,
      staleRunMs: 2 * 60 * 60 * 1000,
      retentionMs: 14 * 24 * 60 * 60 * 1000,
    });
    assert.equal(report.reconciled, 1);
    assert.equal(report.deleted, 1);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(runningDirectory, "receipt.json"), "utf8")).status,
      "failed",
    );
    await assert.rejects(fs.stat(terminalDirectory), { code: "ENOENT" });
  } finally {
    await dispose(home);
  }
});

test("future-dated receipt lifecycle is invalid and never cleanup-eligible", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-store-future-receipt-"));
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const receipts = [
    {
      runId: "20200101000000000-rg_search_fast-aaaaaaaaaaaa",
      status: "running",
      started_at: "2027-01-01T00:00:00.000Z",
      completed_at: null,
    },
    {
      runId: "20200101000000001-rg_search_fast-bbbbbbbbbbbb",
      status: "completed",
      started_at: "2026-12-31T00:00:00.000Z",
      completed_at: "2027-01-01T00:00:00.000Z",
    },
  ];
  try {
    for (const receipt of receipts) {
      const runDirectory = path.join(home, "rg", "runs", receipt.runId);
      await fs.mkdir(runDirectory, { recursive: true });
      await fs.writeFile(
        path.join(runDirectory, "receipt.json"),
        `${JSON.stringify({ schema: "rg.receipt.v1", run_id: receipt.runId, ...receipt })}\n`,
      );
    }
    const report = await maintainRunStore(home, {
      nowMs,
      staleRunMs: 1,
      retentionMs: 1,
      countCleanupMinAgeMs: 0,
      maxRetainedRuns: 0,
    });
    assert.equal(report.scanned, 0);
    assert.equal(report.invalid_entries, 2);
    assert.equal(report.stale_running, 0);
    assert.equal(report.cleanup_eligible, 0);
    assert.equal(report.reconciled, 0);
    assert.equal(report.deleted, 0);
    for (const { runId } of receipts) {
      assert.equal((await fs.stat(path.join(home, "rg", "runs", runId))).isDirectory(), true);
    }
  } finally {
    await dispose(home);
  }
});

test("concurrent run-store cleanup counts each deletion exactly once", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-run-store-concurrent-"));
  const nowMs = Date.now();
  const runIds = [
    "20200101000000000-rg_search_fast-aaaaaaaaaaaa",
    "20200101000000001-rg_search_fast-bbbbbbbbbbbb",
  ];
  try {
    for (const runId of runIds) {
      const runDirectory = path.join(home, "rg", "runs", runId);
      await fs.mkdir(runDirectory, { recursive: true });
      await fs.writeFile(
        path.join(runDirectory, "receipt.json"),
        `${JSON.stringify({
          schema: "rg.receipt.v1",
          run_id: runId,
          status: "completed",
          started_at: new Date(nowMs - 31 * 24 * 60 * 60 * 1000).toISOString(),
          completed_at: new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString(),
        })}\n`,
      );
    }
    const reports = await Promise.all(
      Array.from({ length: 4 }, () =>
        maintainRunStore(home, {
          nowMs,
          retentionMs: 14 * 24 * 60 * 60 * 1000,
          maxRetainedRuns: 200,
        }),
      ),
    );
    assert.equal(
      reports.reduce((total, report) => total + report.deleted, 0),
      runIds.length,
    );
    for (const runId of runIds) {
      await assert.rejects(fs.stat(path.join(home, "rg", "runs", runId)), { code: "ENOENT" });
    }
  } finally {
    await dispose(home);
  }
});

test("strict discovery validation accepts evidence and extracts a semantic trigger", async () => {
  const directory = await fixture();
  try {
    const snapshot = await computeFingerprint(directory);
    const value = discovery(snapshot);
    value.uncertainties.push("trigger:cross-file-gap: referenced implementation is outside this fixture");
    assert.deepEqual(await validateResultObject(value, directory, snapshot), ["cross-file-gap"]);
  } finally {
    await dispose(directory);
  }
});

test("strict discovery validation rejects repository escapes and malformed ranges", async () => {
  const directory = await fixture();
  try {
    const snapshot = await computeFingerprint(directory);
    for (const rejectedPath of [
      "../source.js",
      "C:/private/source.js",
      "C:private/source.js",
      "/private/source.js",
    ]) {
      const escaped = discovery(snapshot);
      escaped.owners[0].path = rejectedPath;
      await assert.rejects(
        validateResultObject(escaped, directory, snapshot),
        (error) =>
          error instanceof RGError &&
          error.code === "invalid-result" &&
          error.details.category === "unsafe-path" &&
          error.details.field === "owners[0].path" &&
          !("rejected_value" in error.details.validation_errors[0]),
      );
    }

    const inverted = discovery(snapshot);
    inverted.owners[0].line_start = 3;
    inverted.owners[0].line_end = 2;
    await assert.rejects(
      validateResultObject(inverted, directory, snapshot),
      (error) => error instanceof RGError && error.code === "invalid-result",
    );

    for (const [lineStart, lineEnd] of [
      [0, 1],
      [1.5, 2],
      [1, 2.5],
    ]) {
      const malformed = discovery(snapshot);
      malformed.owners[0].line_start = lineStart;
      malformed.owners[0].line_end = lineEnd;
      await assert.rejects(
        validateResultObject(malformed, directory, snapshot),
        (error) => error instanceof RGError && error.code === "invalid-result",
      );
    }
  } finally {
    await dispose(directory);
  }
});

test("regression: an invented intermediate directory is rejected in flows evidence", async () => {
  const directory = await fixture();
  const regression = JSON.parse(
    await fs.readFile(new URL("./fixtures/path-hallucination.json", import.meta.url), "utf8"),
  );
  try {
    const inventoryFile = path.join(directory, ...regression.inventory_path.split("/"));
    await fs.mkdir(path.dirname(inventoryFile), { recursive: true });
    await fs.writeFile(inventoryFile, "void OnTick() {}\n");
    const snapshot = await computeFingerprint(directory);
    const value = discovery(snapshot);
    value.flows.push({
      ...value.owners[0],
      path: regression.rejected_path,
      symbol: "OnTick",
      kind: "flow",
    });
    await assert.rejects(
      validateResultObject(value, directory, snapshot),
      (error) => {
        assert.equal(error instanceof RGError, true);
        assert.equal(error.code, "invalid-result");
        assert.equal(error.message, regression.expected_message);
        assert.equal(error.details.category, "path-outside-inventory");
        assert.equal(error.details.field, "flows[0].path");
        assert.equal(
          error.details.validation_errors[0].rejected_value,
          regression.rejected_path,
        );
        assert.deepEqual(error.details.validation_errors[0].candidates, [
          {
            path: regression.inventory_path,
            confidence: 0.85,
            source: "owner-fingerprint-inventory",
          },
        ]);
        return true;
      },
    );
  } finally {
    await dispose(directory);
  }
});

test("owner path preflight exposes bounded exact inventory hints and candidates", async () => {
  const directory = await fixture();
  try {
    for (const relative of [
      "app/EntrySubmission.mqh",
      "src/EntrySubmission.mqh",
      "generated/EntrySubmission.mqh",
      ...Array.from({ length: 7 }, (_, index) => `d${index}/Owner.mqh`),
    ]) {
      const full = path.join(directory, ...relative.split("/"));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, `// ${relative}\n`);
    }
    const snapshot = await computeFingerprint(directory);
    const preflight = buildPathPreflight("Trace EntrySubmission and source.js.", snapshot);
    assert.deepEqual(preflight, {
      source: "owner-fingerprint-inventory",
      fingerprint_digest: snapshot.public.digest,
      complete: false,
      paths: ["app/EntrySubmission.mqh", "src/EntrySubmission.mqh", "source.js"],
    });
    assert.doesNotMatch(buildSearchPrompt("Trace EntrySubmission and source.js.", snapshot), /generated/);

    const value = discovery(snapshot);
    value.flows.push({
      ...value.owners[0],
      path: "target/Owner.mqh",
      symbol: "Owner",
      kind: "flow",
    });
    await assert.rejects(
      validateResultObject(value, directory, snapshot),
      (error) => {
        const issue = error.details.validation_errors[0];
        assert.equal(issue.category, "path-outside-inventory");
        assert.equal(issue.candidates.length, 5);
        assert.deepEqual(
          issue.candidates.map(({ path: candidatePath }) => candidatePath),
          ["d0/Owner.mqh", "d1/Owner.mqh", "d2/Owner.mqh", "d3/Owner.mqh", "d4/Owner.mqh"],
        );
        assert.equal(issue.candidates.every(({ source }) => source === "owner-fingerprint-inventory"), true);
        return true;
      },
    );
  } finally {
    await dispose(directory);
  }
});

test("discovery validation aggregates typed errors across groups without mutating evidence", async () => {
  const directory = await fixture();
  try {
    const snapshot = await computeFingerprint(directory);
    const value = discovery(snapshot);
    value.owners[0].line_end = 500;
    value.owners[0].symbol = "";
    value.couplings.push({
      ...value.owners[0],
      line_start: 4,
      line_end: 5,
      symbol: "coupling",
    });
    value.tests.push({
      ...value.owners[0],
      line_start: 3,
      line_end: 2,
      symbol: "test",
    });
    value.flows.push({
      ...value.owners[0],
      path: "invented/source.js",
      line_end: 3,
      symbol: "flow",
    });
    value.uncertainties.push("trigger:not-configured: reject this trigger");

    await assert.rejects(
      validateResultObject(value, directory, snapshot),
      (error) => {
        assert.equal(error instanceof RGError, true);
        assert.equal(error.code, "invalid-result");
        assert.deepEqual(
          error.details.validation_errors.map(({ category, field }) => [category, field]),
          [
            ["invalid-fields", "owners[0].symbol"],
            ["line-range-no-overlap", "couplings[0]"],
            ["invalid-line-range", "tests[0]"],
            ["path-outside-inventory", "flows[0].path"],
            ["invalid-fields", "uncertainties[0]"],
          ],
        );
        const failedRun = failureResult(error);
        assert.deepEqual(failedRun.validation_errors, error.details.validation_errors);
        assert.equal(failedRun.validation_error_count, 5);
        assert.equal(failedRun.validation_errors_truncated, false);
        return true;
      },
    );
    assert.equal(value.owners[0].line_end, 500);
  } finally {
    await dispose(directory);
  }
});

test("public validation diagnostics are capped and disclose truncation", async () => {
  const directory = await fixture();
  try {
    const snapshot = await computeFingerprint(directory);
    const value = discovery(snapshot);
    value.owners = Array.from({ length: 64 }, () => ({}));
    value.couplings = [{}];

    await assert.rejects(
      validateResultObject(value, directory, snapshot),
      (error) => {
        assert.equal(error.details.validation_error_count, 130);
        assert.equal(error.details.validation_errors.length, 128);
        assert.equal(error.details.validation_errors_truncated, true);
        const failedRun = failureResult(error);
        assert.equal(failedRun.validation_error_count, 130);
        assert.equal(failedRun.validation_errors.length, 128);
        assert.equal(failedRun.validation_errors_truncated, true);
        return true;
      },
    );
  } finally {
    await dispose(directory);
  }
});

test("same-model repair policy is bounded to explicit contract categories", () => {
  const failure = (category, count = 1, truncated = false) =>
    new RGError("invalid result", "invalid-result", {
      category,
      field: "owners[0]",
      validation_errors: [
        { category, field: "owners[0]", message: "invalid result" },
      ],
      validation_error_count: count,
      validation_errors_truncated: truncated,
    });

  for (const category of [
    "path-outside-inventory",
    "invalid-line-range",
    "line-range-no-overlap",
    "invalid-fields",
  ]) {
    assert.deepEqual(sameModelRepairDecision(failure(category)).eligible, true, category);
  }
  for (const category of [
    "unsafe-path",
    "ignored-content",
    "linked-path",
    "fingerprint-mismatch",
    "malformed-result",
  ]) {
    const decision = sameModelRepairDecision(failure(category));
    assert.equal(decision.eligible, false, category);
    assert.equal(decision.reason, `non-repairable-category:${category}`);
  }
  assert.equal(sameModelRepairDecision(failure("invalid-fields", 21)).eligible, false);
  assert.equal(sameModelRepairDecision(failure("invalid-fields", 2, true)).eligible, false);
  assert.equal(sameModelRepairDecision(new RGError("timeout", "worker-timeout")).eligible, false);
});

test("typed discovery diagnostics distinguish ignored, linked, fingerprint, and malformed results", async () => {
  const directory = await fixture();
  let linked;
  try {
    const generated = path.join(directory, "generated", "source.js");
    await fs.mkdir(path.dirname(generated), { recursive: true });
    await fs.writeFile(generated, "export const generated = true;\n");
    const snapshot = await computeFingerprint(directory);

    const ignored = discovery(snapshot);
    ignored.owners[0].path = "generated/source.js";
    await assert.rejects(
      validateResultObject(ignored, directory, snapshot),
      (error) => error.details?.category === "ignored-content",
    );

    const target = path.join(directory, "link-target");
    linked = path.join(directory, "linked");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "source.js"), "export const linked = true;\n");
    await fs.symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    const linkedSnapshot = {
      public: snapshot.public,
      paths: new Set(["linked/source.js"]),
      lineCounts: new Map([["linked/source.js", 1]]),
    };
    const linkedResult = discovery(linkedSnapshot);
    linkedResult.owners[0].path = "linked/source.js";
    await assert.rejects(
      validateResultObject(linkedResult, directory, linkedSnapshot),
      (error) => error.details?.category === "linked-path",
    );
    await fs.unlink(linked);
    linked = undefined;

    const mismatch = discovery(snapshot);
    mismatch.worktree_fingerprint = {
      ...snapshot.public,
      digest: snapshot.public.digest.startsWith("0")
        ? `1${snapshot.public.digest.slice(1)}`
        : `0${snapshot.public.digest.slice(1)}`,
    };
    await assert.rejects(
      validateResultObject(mismatch, directory, snapshot),
      (error) => error.details?.category === "fingerprint-mismatch",
    );

    const malformed = discovery(snapshot);
    malformed.worktree_fingerprint = null;
    await assert.rejects(
      validateResultObject(malformed, directory, snapshot),
      (error) => error.details?.category === "malformed-result",
    );
  } finally {
    if (linked) await fs.unlink(linked).catch(() => {});
    await dispose(directory);
  }
});

test("strict discovery validation bounds usable model line ranges", async () => {
  const directory = await fixture();
  try {
    const longSource = Array.from({ length: 300 }, (_, index) => `// line ${index + 1}`).join("\n");
    await fs.writeFile(path.join(directory, "source.js"), `${longSource}\n`);
    const snapshot = await computeFingerprint(directory);

    const allGroups = discovery(snapshot);
    const evidence = { ...allGroups.owners[0], line_start: 25, line_end: 250 };
    allGroups.owners[0] = { ...evidence, symbol: "owner" };
    allGroups.couplings.push({ ...evidence, symbol: "coupling" });
    allGroups.tests.push({ ...evidence, symbol: "test" });
    allGroups.flows.push({ ...evidence, symbol: "flow" });
    await validateResultObject(allGroups, directory, snapshot);
    for (const group of ["owners", "couplings", "tests", "flows"]) {
      assert.deepEqual(
        [allGroups[group][0].line_start, allGroups[group][0].line_end],
        [25, 224],
      );
    }

    const exactLimit = discovery(snapshot);
    exactLimit.owners[0].line_start = 101;
    exactLimit.owners[0].line_end = 300;
    await validateResultObject(exactLimit, directory, snapshot);
    assert.deepEqual([exactLimit.owners[0].line_start, exactLimit.owners[0].line_end], [101, 300]);

    const pastEnd = discovery(snapshot);
    pastEnd.owners[0].line_start = 275;
    pastEnd.owners[0].line_end = 350;
    await validateResultObject(pastEnd, directory, snapshot);
    assert.deepEqual([pastEnd.owners[0].line_start, pastEnd.owners[0].line_end], [275, 300]);

    const noOverlap = discovery(snapshot);
    noOverlap.owners[0].line_start = 301;
    noOverlap.owners[0].line_end = 350;
    await assert.rejects(
      validateResultObject(noOverlap, directory, snapshot),
      (error) => error instanceof RGError && error.code === "invalid-result",
    );
  } finally {
    await dispose(directory);
  }
});

test("failed discovery validation never partially normalizes evidence", async () => {
  const directory = await fixture();
  try {
    const snapshot = await computeFingerprint(directory);

    const invalidOwner = discovery(snapshot);
    invalidOwner.owners[0].line_end = 500;
    invalidOwner.owners[0].symbol = "";
    await assert.rejects(
      validateResultObject(invalidOwner, directory, snapshot),
      (error) =>
        error instanceof RGError &&
        error.code === "invalid-result" &&
        error.details.category === "invalid-fields",
    );
    assert.equal(invalidOwner.owners[0].line_end, 500);

    const invalidLateGroup = discovery(snapshot);
    invalidLateGroup.owners[0].line_end = 500;
    invalidLateGroup.flows.push({ ...invalidLateGroup.owners[0], line_end: 3, symbol: "" });
    await assert.rejects(
      validateResultObject(invalidLateGroup, directory, snapshot),
      (error) =>
        error instanceof RGError &&
        error.code === "invalid-result" &&
        error.details.validation_errors.some(({ field }) => field === "flows[0].symbol"),
    );
    assert.equal(invalidLateGroup.owners[0].line_end, 500);

    const invalidTrigger = discovery(snapshot);
    invalidTrigger.owners[0].line_end = 500;
    invalidTrigger.uncertainties.push("trigger:not-configured: invalid trigger must reject the result");
    await assert.rejects(
      validateResultObject(invalidTrigger, directory, snapshot),
      (error) => error instanceof RGError && error.code === "invalid-result",
    );
    assert.equal(invalidTrigger.owners[0].line_end, 500);
  } finally {
    await dispose(directory);
  }
});

test("fingerprint line counts cover empty, final-newline, and CRLF files", async () => {
  const directory = await fixture();
  try {
    const cases = [
      ["empty.js", "", 1],
      ["no-final-newline.js", "one", 1],
      ["final-newline.js", "one\n", 1],
      ["crlf.js", "one\r\ntwo\r\n", 2],
    ];
    for (const [relative, contents] of cases) {
      await fs.writeFile(path.join(directory, relative), contents);
    }
    const snapshot = await computeFingerprint(directory);
    for (const [relative, , expectedLines] of cases) {
      assert.equal(snapshot.lineCounts.get(relative), expectedLines, relative);
      const value = discovery(snapshot);
      value.owners[0].path = relative;
      value.owners[0].line_end = expectedLines;
      await validateResultObject(value, directory, snapshot);
    }
  } finally {
    await dispose(directory);
  }
});

test("result artifact stays raw while the accepted value is normalized", async () => {
  const directory = await fixture();
  try {
    const longSource = Array.from({ length: 300 }, (_, index) => `// line ${index + 1}`).join("\n");
    await fs.writeFile(path.join(directory, "source.js"), `${longSource}\n`);
    const snapshot = await computeFingerprint(directory);
    const resultFile = path.join(directory, "result.json");
    const rawValue = discovery(snapshot);
    rawValue.owners[0].line_end = 250;
    await fs.writeFile(resultFile, `${JSON.stringify(rawValue)}\n`);

    const validated = await readAndValidateResult(resultFile, directory, snapshot);
    assert.equal(validated.value.owners[0].line_end, 200);
    assert.deepEqual(validated.triggers, []);
    assert.equal(JSON.parse(await fs.readFile(resultFile, "utf8")).owners[0].line_end, 250);

    const invalidValue = discovery(snapshot);
    invalidValue.owners[0].symbol = "";
    await fs.writeFile(resultFile, `${JSON.stringify(invalidValue)}\n`);
    await assert.rejects(
      readAndValidateResult(resultFile, directory, snapshot),
      (error) =>
        error instanceof RGError &&
        error.code === "invalid-result" &&
        error.details.category === "invalid-fields" &&
        error.details.field === "owners[0].symbol",
    );

    await fs.writeFile(resultFile, "{not-json\n");
    await assert.rejects(
      readAndValidateResult(resultFile, directory, snapshot),
      (error) =>
        error instanceof RGError &&
        error.code === "invalid-result" &&
        error.details.category === "malformed-result" &&
        error.details.field === "result artifact",
    );
  } finally {
    await dispose(directory);
  }
});

test("only configured semantic trigger names are accepted", () => {
  assert.deepEqual(extractTriggers(["ordinary uncertainty"]), []);
  assert.throws(
    () => extractTriggers(["trigger:model-unavailable: do not reroute transport failures"]),
    (error) => error instanceof RGError && error.code === "invalid-result",
  );
});

test("profiles and route map preserve exact-model read-only invariants", async () => {
  const fastPath = new URL("../profiles/rg_search_fast.json", import.meta.url);
  const mapPath = new URL("../profiles/model-map.json", import.meta.url);
  const fast = JSON.parse(await fs.readFile(fastPath, "utf8"));
  const map = JSON.parse(await fs.readFile(mapPath, "utf8"));
  assert.equal(validateProfile(fast, "rg_search_fast", "fixture").model, "gpt-5.6-luna");
  assert.deepEqual(validateModelMap(map, "fixture").value.routes.auto.agents, [
    "rg_search_fast",
    "rg_search_balanced",
  ]);
  assert.throws(
    () => validateProfile({ ...fast, sandbox_mode: "workspace-write" }, "rg_search_fast", "fixture"),
    (error) => error instanceof RGError && error.code === "invalid-configuration",
  );
});

test("Codex dispatch pins model, effort, subscription provider, and read-only sandbox", async () => {
  const fast = JSON.parse(
    await fs.readFile(new URL("../profiles/rg_search_fast.json", import.meta.url), "utf8"),
  );
  const args = buildCodexArgs(fast, process.cwd(), path.join(process.cwd(), "result.json"), "bounded");
  assert.equal(args[args.indexOf("-m") + 1], "gpt-5.6-luna");
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes('model_provider="openai"'));
  assert.ok(args.includes("features.multi_agent=false"));
  const skillConfig = args.find((arg) => arg.startsWith("skills.config="));
  assert.ok(skillConfig);
  assert.match(skillConfig, /enabled=false/);
  assert.match(skillConfig, /RG/i);
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(args.includes("--output-schema"));
});

test("child instructions and config suppress recursive RG invocation through a linked install", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rg-test-skill-home-"));
  const linked = path.join(directory, "skills", "rg");
  const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  await fs.mkdir(path.dirname(linked), { recursive: true });
  try {
    await fs.symlink(repository, linked, process.platform === "win32" ? "junction" : "dir");
    const paths = rgSkillDisablePaths(directory);
    assert.ok(paths.includes(path.resolve(linked, "SKILL.md")));
    assert.ok(paths.includes(await fs.realpath(path.join(repository, "SKILL.md"))));
    assert.ok(paths.every((skillPath) => path.basename(skillPath) === "SKILL.md"));

    const instructions = developerInstructions(
      { name: "rg_search_fast" },
      { algorithm: "sha256", digest: "0".repeat(64), files: 1, bytes: 1, inventory: "git-tracked-untracked-nonignored-v1" },
    );
    assert.match(instructions, /parent has already satisfied every instruction to invoke the \$rg skill/i);
    assert.match(instructions, /Do not invoke or delegate to the RG skill/i);
    assert.match(instructions, /do not execute them as a nested search/i);
    assert.match(instructions, /Focused reads.+including files named rg\.mjs/i);
    assert.match(instructions, /Do not diagnose or report RG authentication/i);

    const args = buildCodexArgs(
      { model: "gpt-5.6-luna", model_reasoning_effort: "low" },
      process.cwd(),
      path.join(process.cwd(), "result.json"),
      instructions,
      paths,
    );
    const skillConfig = args.find((arg) => arg.startsWith("skills.config="));
    assert.match(skillConfig, /SKILL\.md/);
    assert.equal((skillConfig.match(/enabled=false/g) ?? []).length, paths.length);
  } finally {
    try {
      await fs.unlink(linked);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await dispose(directory);
  }
});

test("credential environment is scrubbed and provider redirects are rejected", async () => {
  const cleaned = scrubEnvironment({ PATH: "safe", OPENAI_API_KEY: "secret", CODEX_API_KEY: "secret" });
  assert.deepEqual(cleaned, { PATH: "safe" });

  const directory = await fixture();
  try {
    const config = path.join(directory, "config.toml");
    await fs.writeFile(config, 'model_provider = "custom"\n');
    await assert.rejects(
      validateSubscriptionConfig(config),
      (error) => error instanceof RGError && error.code === "invalid-configuration",
    );
  } finally {
    await dispose(directory);
  }
});

test("a first-step transport failure blocks the route before Terra", async () => {
  const profiles = [
    { name: "rg_search_fast", model: "gpt-5.6-luna", model_reasoning_effort: "low" },
    { name: "rg_search_balanced", model: "gpt-5.6-terra", model_reasoning_effort: "medium" },
  ];
  const resolved = {
    map: { sha256: "0".repeat(64) },
    route: {
      escalation_triggers: ["insufficient-evidence", "ambiguous-ownership", "cross-file-gap"],
    },
    profiles,
  };
  const calls = [];
  await assert.rejects(
    executeResolvedRoute({
      resolved,
      root: process.cwd(),
      query: "bounded",
      codexBin: "unused",
      timeoutMs: 30_000,
      runStep: async ({ profile }) => {
        calls.push(profile.name);
        throw new RGError("model unavailable", "runner-failed");
      },
    }),
    (error) => error instanceof RGError && error.code === "runner-failed",
  );
  assert.deepEqual(calls, ["rg_search_fast"]);
});

test("a valid configured evidence gap permits exactly one Terra step", async () => {
  const profiles = [
    { name: "rg_search_fast", model: "gpt-5.6-luna", model_reasoning_effort: "low" },
    { name: "rg_search_balanced", model: "gpt-5.6-terra", model_reasoning_effort: "medium" },
  ];
  const resolved = {
    map: { sha256: "0".repeat(64) },
    route: { escalation_triggers: ["cross-file-gap"] },
    profiles,
  };
  const calls = [];
  const fingerprint = { algorithm: "sha256", digest: "1".repeat(64) };
  const routed = await executeResolvedRoute({
    resolved,
    root: process.cwd(),
    query: "bounded",
    codexBin: "unused",
    timeoutMs: 30_000,
    runStep: async ({ profile }) => {
      calls.push(profile.name);
      return {
        fingerprint,
        result: { summary: profile.name },
        triggers: profile.name === "rg_search_fast" ? ["cross-file-gap"] : [],
        receipt: `${profile.name}.json`,
      };
    },
  });
  assert.deepEqual(calls, ["rg_search_fast", "rg_search_balanced"]);
  assert.equal(routed.current.result.summary, "rg_search_balanced");
  assert.equal(routed.steps.length, 2);
});

test("validated fingerprint drift restarts the whole route exactly once", async () => {
  const profiles = [
    { name: "rg_search_fast", model: "gpt-5.6-luna", model_reasoning_effort: "low" },
    { name: "rg_search_balanced", model: "gpt-5.6-terra", model_reasoning_effort: "medium" },
  ];
  const resolved = {
    map: { sha256: "0".repeat(64) },
    route: { escalation_triggers: ["cross-file-gap"] },
    profiles,
  };
  const before = syntheticSnapshot("1");
  const after = syntheticSnapshot("2");
  const calls = [];
  const routed = await executeResolvedRoute({
    resolved,
    root: process.cwd(),
    query: "bounded",
    codexBin: "unused",
    timeoutMs: 30_000,
    runStep: async ({ profile, routeAttempt }) => {
      calls.push(`${routeAttempt}:${profile.name}`);
      if (routeAttempt === 1 && profile.name === "rg_search_balanced") {
        const error = fingerprintDriftError(
          "worktree drifted before Terra",
          "before-route-step",
          before,
          after,
        );
        error.details.receipt = "balanced-drift.json";
        throw error;
      }
      return {
        fingerprint: after.public,
        snapshot: after,
        result: { summary: `${routeAttempt}:${profile.name}` },
        triggers:
          routeAttempt === 1 && profile.name === "rg_search_fast" ? ["cross-file-gap"] : [],
        receipt: `${routeAttempt}-${profile.name}.json`,
        repair: { attempted: false },
      };
    },
  });
  assert.deepEqual(calls, [
    "1:rg_search_fast",
    "1:rg_search_balanced",
    "2:rg_search_fast",
  ]);
  assert.equal(routed.current.result.summary, "2:rg_search_fast");
  assert.equal(routed.steps.length, 1);
  assert.equal(routed.restart.attempted, true);
  assert.equal(routed.restart.attempt_limit, 1);
  assert.equal(routed.restart.restart_count, 1);
  assert.equal(routed.restart.outcome, "completed");
  assert.equal(routed.restart.first_drift.phase, "before-route-step");
  assert.deepEqual(
    routed.restart.discarded_steps.map(({ profile, result }) => ({ profile, result })),
    [
      { profile: "rg_search_fast", result: "completed" },
      { profile: "rg_search_balanced", result: "fingerprint-drift" },
    ],
  );
});

test("unstructured drift code is not sufficient to authorize a restart", async () => {
  const resolved = {
    map: { sha256: "0".repeat(64) },
    route: { escalation_triggers: [] },
    profiles: [
      { name: "rg_search_fast", model: "gpt-5.6-luna", model_reasoning_effort: "low" },
    ],
  };
  let calls = 0;
  await assert.rejects(
    executeResolvedRoute({
      resolved,
      root: process.cwd(),
      query: "bounded",
      codexBin: "unused",
      timeoutMs: 30_000,
      runStep: async () => {
        calls += 1;
        throw new RGError("unproven drift", "fingerprint-drift");
      },
    }),
    (error) => error instanceof RGError && error.code === "fingerprint-drift",
  );
  assert.equal(calls, 1);
});

test("a second validated drift is terminal and reports exhausted restart budget", async () => {
  const resolved = {
    map: { sha256: "0".repeat(64) },
    route: { escalation_triggers: [] },
    profiles: [
      { name: "rg_search_fast", model: "gpt-5.6-luna", model_reasoning_effort: "low" },
    ],
  };
  const before = syntheticSnapshot("1");
  const after = syntheticSnapshot("2");
  let calls = 0;
  let rejection;
  await assert.rejects(
    executeResolvedRoute({
      resolved,
      root: process.cwd(),
      query: "bounded",
      codexBin: "unused",
      timeoutMs: 30_000,
      runStep: async () => {
        calls += 1;
        throw fingerprintDriftError("repeated drift", "during-search", before, after);
      },
    }),
    (error) => {
      rejection = error;
      return error instanceof RGError && error.code === "fingerprint-drift";
    },
  );
  assert.equal(calls, 2);
  const failed = failureResult(rejection);
  assert.equal(failed.restart.attempted, true);
  assert.equal(failed.restart.restart_count, 1);
  assert.equal(failed.restart.outcome, "exhausted");
  assert.equal(failed.restart.first_drift.phase, "during-search");
});
