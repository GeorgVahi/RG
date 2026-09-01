import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  RGError,
  buildCodexArgs,
  developerInstructions,
  failureResult,
  performSearch,
  rgSkillDisablePaths,
} from "../scripts/rg.mjs";

async function temporary(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function repository() {
  const directory = await temporary("rg-integration-repo-");
  execFileSync("git", ["init", "--quiet", directory]);
  await fs.writeFile(path.join(directory, "source.js"), "export function owner() {\n  return 1;\n}\n");
  return directory;
}

async function removeTemporary(directory) {
  const resolved = path.resolve(directory);
  assert.match(path.basename(resolved), /^rg-integration-(?:repo|home)-/);
  await fs.rm(resolved, { recursive: true, force: true });
}

test("fake Codex exercises successful and invalid-result run artifacts", { concurrency: false }, async (t) => {
  const home = await temporary("rg-integration-home-");
  const linkedSkill = path.join(home, "skills", "rg");
  const skillRepository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const previousHome = process.env.CODEX_HOME;
  const previousScenario = process.env.RG_FAKE_CODEX_SCENARIO;
  const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
  await fs.mkdir(path.dirname(linkedSkill), { recursive: true });
  await fs.symlink(skillRepository, linkedSkill, process.platform === "win32" ? "junction" : "dir");
  process.env.CODEX_HOME = home;

  try {
    await t.test("real Codex prompt parser removes RG from the child-visible skill catalog", () => {
      const environment = { ...process.env, CODEX_HOME: home };
      const control = spawnSync("codex", ["debug", "prompt-input", "bounded repository search"], {
        cwd: skillRepository,
        encoding: "utf8",
        env: environment,
        windowsHide: true,
      });
      if (control.error?.code === "ENOENT") {
        t.diagnostic("Codex CLI is unavailable; prompt-parser assertion skipped");
        return;
      }
      assert.equal(control.status, 0, control.stderr);
      assert.match(control.stdout, /- rg:/i);

      const instructions = developerInstructions(
        { name: "rg_search_fast" },
        { algorithm: "sha256", digest: "0".repeat(64), files: 1, bytes: 1, inventory: "git-tracked-untracked-nonignored-v1" },
      );
      const args = buildCodexArgs(
        { model: "gpt-5.6-luna", model_reasoning_effort: "low" },
        skillRepository,
        path.join(home, "result.json"),
        instructions,
        rgSkillDisablePaths(home),
      );
      const skillConfig = args.find((arg) => arg.startsWith("skills.config="));
      const suppressed = spawnSync(
        "codex",
        ["debug", "prompt-input", "-c", skillConfig, "bounded repository search"],
        {
          cwd: skillRepository,
          encoding: "utf8",
          env: environment,
          windowsHide: true,
        },
      );
      assert.equal(suppressed.status, 0, suppressed.stderr);
      assert.doesNotMatch(suppressed.stdout, /- rg:/i);
    });

    await t.test("valid discovery completes through the real runner", async () => {
      const repo = await repository();
      process.env.RG_FAKE_CODEX_SCENARIO = "valid";
      try {
        const result = await performSearch({
          repo,
          query: "Locate the source.js fixture owner and flow.",
          mode: "fast",
          codexBin: process.execPath,
          codexArgsPrefix: [fakeCodex],
          timeoutMs: 30_000,
        });
        assert.equal(result.status, "completed");
        assert.equal(result.result.owners[0].path, "source.js");
        assert.equal(result.steps.length, 1);
        assert.equal(result.steps[0].repair.attempted, false);
      } finally {
        await removeTemporary(repo);
      }
    });

    await t.test("one external fingerprint drift restarts from Luna and completes", async () => {
      const repo = await repository();
      process.env.RG_FAKE_CODEX_SCENARIO = "fingerprint-drift-once";
      await fs.unlink(path.join(home, "rg", "fake-fingerprint-drift-once.marker")).catch(() => {});
      try {
        const result = await performSearch({
          repo,
          query: "Locate the source.js fixture owner after an external edit.",
          mode: "fast",
          codexBin: process.execPath,
          codexArgsPrefix: [fakeCodex],
          timeoutMs: 30_000,
        });
        assert.equal(result.status, "completed");
        assert.equal(result.restart.attempted, true);
        assert.equal(result.restart.attempt_limit, 1);
        assert.equal(result.restart.restart_count, 1);
        assert.equal(result.restart.outcome, "completed");
        assert.equal(result.restart.first_drift.phase, "during-search");
        assert.equal(result.restart.first_drift.changes.modified, 1);
        assert.equal(result.restart.discarded_steps.length, 1);
        assert.equal(result.steps.length, 1);
        assert.equal(result.steps[0].profile, "rg_search_fast");

        const discardedReceipt = JSON.parse(
          await fs.readFile(result.restart.discarded_steps[0].receipt, "utf8"),
        );
        const completedReceipt = JSON.parse(await fs.readFile(result.steps[0].receipt, "utf8"));
        assert.equal(discardedReceipt.status, "failed");
        assert.equal(discardedReceipt.failure_reason, "fingerprint-drift");
        assert.equal(discardedReceipt.result_evidence, "unvalidated");
        assert.equal(discardedReceipt.fingerprint_drift.phase, "during-search");
        assert.equal(completedReceipt.status, "completed");
      } finally {
        await removeTemporary(repo);
      }
    });

    await t.test("a second external fingerprint drift exhausts the single restart", async () => {
      const repo = await repository();
      process.env.RG_FAKE_CODEX_SCENARIO = "fingerprint-drift-always";
      try {
        let rejection;
        await assert.rejects(
          performSearch({
            repo,
            query: "Locate the source.js fixture owner under repeated external edits.",
            mode: "fast",
            codexBin: process.execPath,
            codexArgsPrefix: [fakeCodex],
            timeoutMs: 30_000,
          }),
          (error) => {
            rejection = error;
            return error instanceof RGError && error.code === "fingerprint-drift";
          },
        );
        const failed = failureResult(rejection);
        assert.equal(failed.restart.attempted, true);
        assert.equal(failed.restart.attempt_limit, 1);
        assert.equal(failed.restart.restart_count, 1);
        assert.equal(failed.restart.outcome, "exhausted");
        assert.equal(failed.fingerprint_drift.phase, "during-search");
        const firstReceipt = JSON.parse(
          await fs.readFile(failed.restart.discarded_steps[0].receipt, "utf8"),
        );
        const secondReceipt = JSON.parse(await fs.readFile(rejection.details.receipt, "utf8"));
        assert.equal(firstReceipt.status, "failed");
        assert.equal(secondReceipt.status, "failed");
        assert.equal(firstReceipt.failure_reason, "fingerprint-drift");
        assert.equal(secondReceipt.failure_reason, "fingerprint-drift");
        assert.equal(firstReceipt.result_evidence, "unvalidated");
        assert.equal(secondReceipt.result_evidence, "unvalidated");
      } finally {
        await removeTemporary(repo);
      }
    });

    await t.test("unexpected post-run parsing failure terminalizes the running receipt", async () => {
      const repo = await repository();
      process.env.RG_FAKE_CODEX_SCENARIO = "malformed-events";
      try {
        let rejection;
        await assert.rejects(
          performSearch({
            repo,
            query: "Locate the source.js fixture owner and flow.",
            mode: "fast",
            codexBin: process.execPath,
            codexArgsPrefix: [fakeCodex],
            timeoutMs: 30_000,
          }),
          (error) => {
            rejection = error;
            return error instanceof RGError && error.code === "runner-failed";
          },
        );
        const runDirectory = path.dirname(rejection.details.receipt);
        const receipt = JSON.parse(
          await fs.readFile(path.join(runDirectory, "receipt.json"), "utf8"),
        );
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.failure_reason, "runner-failed");
        assert.equal(receipt.result_evidence, "unvalidated");
        assert.deepEqual(receipt.lifecycle, {
          terminalized_by: "run-profile-finalizer",
          reason: "unhandled-run-error",
        });
        await assert.rejects(fs.stat(path.join(runDirectory, "active.json")), { code: "ENOENT" });
      } finally {
        await removeTemporary(repo);
      }
    });

    await t.test("model-invented flow directory is preserved and repaired once", async () => {
      const repo = await repository();
      process.env.RG_FAKE_CODEX_SCENARIO = "invalid-flow-path";
      try {
        const result = await performSearch({
          repo,
          query: "Locate the source.js fixture owner and flow.",
          mode: "fast",
          codexBin: process.execPath,
          codexArgsPrefix: [fakeCodex],
          timeoutMs: 30_000,
        });
        assert.equal(result.status, "completed");
        assert.equal(result.result.flows[0].path, "source.js");
        assert.equal(result.steps[0].repair.attempted, true);
        assert.equal(result.steps[0].repair.outcome, "completed");

        const runDirectory = path.dirname(result.steps[0].receipt);
        const receipt = JSON.parse(
          await fs.readFile(path.join(runDirectory, "receipt.json"), "utf8"),
        );
        const rawResult = JSON.parse(
          await fs.readFile(path.join(runDirectory, "result.json"), "utf8"),
        );
        const repairedResult = JSON.parse(
          await fs.readFile(path.join(runDirectory, "repair-result.json"), "utf8"),
        );
        assert.equal(receipt.status, "completed");
        assert.equal(receipt.repair.attempted, true);
        assert.equal(receipt.repair.outcome, "completed");
        assert.deepEqual(receipt.repair.initial_validation_errors, [
          {
            category: "path-outside-inventory",
            field: "flows[0].path",
            message: "flows[0].path is outside the fingerprint inventory",
            rejected_value: "invented/source.js",
            candidates: [
              {
                path: "source.js",
                confidence: 0.7,
                source: "owner-fingerprint-inventory",
              },
            ],
          },
        ]);
        assert.equal(rawResult.flows[0].path, "invented/source.js");
        assert.equal(repairedResult.flows[0].path, "source.js");
      } finally {
        await removeTemporary(repo);
      }
    });

    await t.test("failed repair is terminal after exactly one same-model attempt", async () => {
      const repo = await repository();
      process.env.RG_FAKE_CODEX_SCENARIO = "invalid-flow-path-twice";
      try {
        let rejection;
        await assert.rejects(
          performSearch({
            repo,
            query: "Locate the source.js fixture owner and flow.",
            mode: "fast",
            codexBin: process.execPath,
            codexArgsPrefix: [fakeCodex],
            timeoutMs: 30_000,
          }),
          (error) => {
            rejection = error;
            return error instanceof RGError && error.code === "invalid-result";
          },
        );
        const runDirectory = path.dirname(rejection.details.receipt);
        const receipt = JSON.parse(
          await fs.readFile(path.join(runDirectory, "receipt.json"), "utf8"),
        );
        const rawResult = JSON.parse(
          await fs.readFile(path.join(runDirectory, "result.json"), "utf8"),
        );
        const repairedResult = JSON.parse(
          await fs.readFile(path.join(runDirectory, "repair-result.json"), "utf8"),
        );
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.failure_reason, "invalid-result");
        assert.equal(receipt.repair.attempted, true);
        assert.equal(receipt.repair.attempt_limit, 1);
        assert.equal(receipt.repair.same_model, true);
        assert.equal(receipt.repair.outcome, "invalid-result");
        assert.equal(receipt.repair.initial_validation_errors[0].category, "path-outside-inventory");
        assert.equal(receipt.validation_errors[0].category, "path-outside-inventory");
        assert.equal(rawResult.flows[0].path, "invented/source.js");
        assert.equal(repairedResult.flows[0].path, "invented/source.js");
        const cliFailure = failureResult(rejection);
        assert.equal(cliFailure.repair.attempted, true);
        assert.equal(cliFailure.repair.attempt_limit, 1);
        assert.equal(cliFailure.repair.same_model, true);
        assert.equal(cliFailure.repair.outcome, "invalid-result");
        const artifacts = await fs.readdir(runDirectory);
        assert.equal(artifacts.filter((name) => name === "repair-result.json").length, 1);
        assert.equal(artifacts.some((name) => name.startsWith("repair-2")), false);
      } finally {
        await removeTemporary(repo);
      }
    });

    await t.test("repair runner failure preserves written result as unvalidated evidence", async () => {
      const repo = await repository();
      process.env.RG_FAKE_CODEX_SCENARIO = "repair-malformed-events";
      try {
        let rejection;
        await assert.rejects(
          performSearch({
            repo,
            query: "Locate the source.js fixture owner and flow.",
            mode: "fast",
            codexBin: process.execPath,
            codexArgsPrefix: [fakeCodex],
            timeoutMs: 30_000,
          }),
          (error) => {
            rejection = error;
            return error instanceof RGError && error.code === "runner-failed";
          },
        );
        const runDirectory = path.dirname(rejection.details.receipt);
        const receipt = JSON.parse(
          await fs.readFile(path.join(runDirectory, "receipt.json"), "utf8"),
        );
        const repairResult = JSON.parse(
          await fs.readFile(path.join(runDirectory, "repair-result.json"), "utf8"),
        );
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.result_evidence, "invalid");
        assert.equal(receipt.repair.attempted, true);
        assert.equal(receipt.repair.outcome, "runner-failed");
        assert.equal(receipt.repair.result_evidence, "unvalidated");
        assert.equal(repairResult.flows[0].path, "source.js");
        assert.equal(failureResult(rejection).repair.result_evidence, "unvalidated");
      } finally {
        await removeTemporary(repo);
      }
    });

    await t.test("missing primary result remains missing rather than invalid", async () => {
      const repo = await repository();
      process.env.RG_FAKE_CODEX_SCENARIO = "missing-result";
      try {
        let rejection;
        await assert.rejects(
          performSearch({
            repo,
            query: "Locate the source.js fixture owner and flow.",
            mode: "fast",
            codexBin: process.execPath,
            codexArgsPrefix: [fakeCodex],
            timeoutMs: 30_000,
          }),
          (error) => {
            rejection = error;
            return error instanceof RGError && error.code === "invalid-result";
          },
        );
        const runDirectory = path.dirname(rejection.details.receipt);
        const receipt = JSON.parse(
          await fs.readFile(path.join(runDirectory, "receipt.json"), "utf8"),
        );
        await assert.rejects(fs.stat(path.join(runDirectory, "result.json")), { code: "ENOENT" });
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.result_evidence, "missing");
      } finally {
        await removeTemporary(repo);
      }
    });

    await t.test("missing repair result is disclosed in receipt and public failure", async () => {
      const repo = await repository();
      process.env.RG_FAKE_CODEX_SCENARIO = "repair-missing-result";
      try {
        let rejection;
        await assert.rejects(
          performSearch({
            repo,
            query: "Locate the source.js fixture owner and flow.",
            mode: "fast",
            codexBin: process.execPath,
            codexArgsPrefix: [fakeCodex],
            timeoutMs: 30_000,
          }),
          (error) => {
            rejection = error;
            return error instanceof RGError && error.code === "invalid-result";
          },
        );
        const runDirectory = path.dirname(rejection.details.receipt);
        const receipt = JSON.parse(
          await fs.readFile(path.join(runDirectory, "receipt.json"), "utf8"),
        );
        await assert.rejects(fs.stat(path.join(runDirectory, "repair-result.json")), {
          code: "ENOENT",
        });
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.result_evidence, "invalid");
        assert.equal(receipt.repair.result_evidence, "missing");
        assert.equal(failureResult(rejection).repair.result_evidence, "missing");
      } finally {
        await removeTemporary(repo);
      }
    });
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousScenario === undefined) delete process.env.RG_FAKE_CODEX_SCENARIO;
    else process.env.RG_FAKE_CODEX_SCENARIO = previousScenario;
    try {
      await fs.unlink(linkedSkill);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await removeTemporary(home);
  }
});
