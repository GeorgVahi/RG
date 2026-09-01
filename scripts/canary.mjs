#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { performSearch } from "./rg.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeCodex = path.join(skillRoot, "tests", "fixtures", "fake-codex.mjs");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rg-canary-"));
const repo = path.join(temporaryRoot, "repo");
const home = path.join(temporaryRoot, "home");
const previousHome = process.env.CODEX_HOME;
const previousScenario = process.env.RG_FAKE_CODEX_SCENARIO;

try {
  await fs.mkdir(repo);
  await fs.mkdir(home);
  execFileSync("git", ["init", "--quiet", repo]);
  await fs.writeFile(
    path.join(repo, "source.js"),
    "export function canaryOwner() {\n  return 'ok';\n}\n",
  );
  process.env.CODEX_HOME = home;
  process.env.RG_FAKE_CODEX_SCENARIO = "valid";

  const result = await performSearch({
    repo,
    query: "Locate the source.js canary owner and return bounded evidence.",
    mode: "fast",
    codexBin: process.execPath,
    codexArgsPrefix: [fakeCodex],
    timeoutMs: 30_000,
  });
  const receipt = JSON.parse(await fs.readFile(result.steps[0].receipt, "utf8"));
  if (
    result.schema !== "rg.run.v1" ||
    result.status !== "completed" ||
    result.steps.length !== 1 ||
    result.steps[0].profile !== "rg_search_fast" ||
    result.restart.attempted !== false ||
    result.result.owners[0]?.path !== "source.js" ||
    receipt.schema !== "rg.receipt.v1" ||
    receipt.status !== "completed" ||
    receipt.result_evidence !== "valid"
  ) {
    throw new Error("RG canary returned an unexpected orchestration contract");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "rg.canary.v1",
        status: "ok",
        checks: [
          "git-fingerprint",
          "fake-codex-transport",
          "strict-result-validation",
          "terminal-receipt",
          "no-unplanned-restart",
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousScenario === undefined) delete process.env.RG_FAKE_CODEX_SCENARIO;
  else process.env.RG_FAKE_CODEX_SCENARIO = previousScenario;
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  if (
    path.dirname(resolvedTemporaryRoot) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolvedTemporaryRoot).startsWith("rg-canary-")
  ) {
    throw new Error("refusing to remove an unexpected canary directory");
  }
  await fs.rm(resolvedTemporaryRoot, { recursive: true, force: true });
}
