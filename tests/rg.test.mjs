import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RGError,
  buildCodexArgs,
  canonicalJson,
  computeFingerprint,
  executeResolvedRoute,
  extractTriggers,
  readAndValidateResult,
  scrubEnvironment,
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
    const escaped = discovery(snapshot);
    escaped.owners[0].path = "../source.js";
    await assert.rejects(
      validateResultObject(escaped, directory, snapshot),
      (error) => error instanceof RGError && error.code === "invalid-path",
    );

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
      (error) => error instanceof RGError && error.code === "invalid-contract",
    );
    assert.equal(invalidOwner.owners[0].line_end, 500);

    const invalidLateGroup = discovery(snapshot);
    invalidLateGroup.owners[0].line_end = 500;
    invalidLateGroup.flows.push({ ...invalidLateGroup.owners[0], line_end: 3, symbol: "" });
    await assert.rejects(
      validateResultObject(invalidLateGroup, directory, snapshot),
      (error) => error instanceof RGError && error.code === "invalid-contract",
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
        error.details.validation_code === "invalid-contract",
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
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(args.includes("--output-schema"));
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
