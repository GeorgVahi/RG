#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    throw new Error(`fake Codex missing ${flag}`);
  }
  return args[index + 1];
}

function ownerFingerprint(args) {
  const setting = args.find((arg) => arg.startsWith("developer_instructions="));
  if (!setting) throw new Error("fake Codex missing developer instructions");
  const instructions = JSON.parse(setting.slice("developer_instructions=".length));
  const match = /Copy this owner-provided worktree_fingerprint exactly:\r?\n(\{[^\r\n]+\})/.exec(
    instructions,
  );
  if (!match) throw new Error("fake Codex could not find the owner fingerprint");
  return JSON.parse(match[1]);
}

async function readPrompt() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "login" && args[1] === "status") {
    process.stdout.write("Logged in using ChatGPT\n");
    return;
  }
  if (args[0] !== "exec") throw new Error(`fake Codex received unsupported command ${args[0]}`);

  const prompt = await readPrompt();
  if (!prompt.includes('"paths":["source.js"]')) {
    throw new Error("fake Codex missing owner-controlled source.js path preflight");
  }
  const isRepair = prompt.includes('"schema":"rg.repair.v1"');
  const resultFile = valueAfter(args, "-o");
  const scenario = process.env.RG_FAKE_CODEX_SCENARIO ?? "valid";
  const invalidFlow =
    scenario === "invalid-flow-path-twice" ||
    ((scenario === "invalid-flow-path" ||
      scenario === "repair-malformed-events" ||
      scenario === "repair-missing-result") &&
      !isRepair);
  const repairedFlow =
    (scenario === "invalid-flow-path" || scenario === "repair-malformed-events") && isRepair;
  const result = {
    schema: "rg.discovery.v1",
    worktree_fingerprint: ownerFingerprint(args),
    summary: "The fixture source owns the requested behavior.",
    owners: [
      {
        path: "source.js",
        line_start: 1,
        line_end: 3,
        symbol: "owner",
        reason: "The exported fixture function owns the behavior.",
        kind: "implementation",
        related_path: null,
      },
    ],
    couplings: [],
    tests: [],
    flows:
      invalidFlow || repairedFlow
        ? [
            {
              path: invalidFlow ? "invented/source.js" : "source.js",
              line_start: 1,
              line_end: 3,
              symbol: "flow",
              reason: invalidFlow
                ? "This intentionally reproduces a model-invented directory."
                : "The same-model repair copied the owner inventory path.",
              kind: "flow",
              related_path: "source.js",
            },
          ]
        : [],
    constraints: [],
    uncertainties: [],
  };
  const omitResult =
    (scenario === "missing-result" && !isRepair) ||
    (scenario === "repair-missing-result" && isRepair);
  if (!omitResult) await fs.writeFile(resultFile, `${JSON.stringify(result)}\n`, "utf8");
  if (scenario === "fingerprint-drift-once" || scenario === "fingerprint-drift-always") {
    let mutate = scenario === "fingerprint-drift-always";
    if (!mutate) {
      const marker = path.join(process.env.CODEX_HOME, "rg", "fake-fingerprint-drift-once.marker");
      try {
        await fs.writeFile(marker, "claimed\n", { encoding: "utf8", flag: "wx" });
        mutate = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    if (mutate) {
      const repo = valueAfter(args, "-C");
      await fs.appendFile(path.join(repo, "source.js"), `// external drift ${Date.now()}\n`);
    }
  }
  if (scenario === "malformed-events" || (scenario === "repair-malformed-events" && isRepair)) {
    process.stdout.write("{malformed-jsonl\n");
    return;
  }
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fake-thread" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
