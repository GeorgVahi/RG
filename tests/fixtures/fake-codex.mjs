#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  if (args[0] === "mcp" && args[1] === "list") {
    process.stdout.write(JSON.stringify([{ name: "unrelated-server", enabled: true }]));
    return;
  }
  if (args[0] === "sandbox") {
    if (process.env.RG_FAKE_CODEX_SCENARIO === "sandbox-denied") {
      process.stdout.write(JSON.stringify({ schema: "rg.sandbox-probe.v1", error: "EACCES" }));
      process.exitCode = 1;
      return;
    }
    const separator = args.indexOf("--");
    const result = spawnSync(args[separator + 1], args.slice(separator + 2), {
      cwd: valueAfter(args, "-C"), encoding: "utf8", windowsHide: true,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exitCode = result.status ?? 1;
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
  if (scenario === "sandbox-denied") throw new Error("sandbox denial incorrectly reached model dispatch");
  if (scenario === "valid-broker" || scenario.startsWith("broker-")) {
    if (!args.includes("features.shell_tool=false") || !args.includes("--ignore-user-config") ||
        !args.includes('approval_policy="never"') || valueAfter(args, "--sandbox") !== "read-only") {
      throw new Error("broker lost read-only confinement");
    }
    const config = args.find((arg) => arg.startsWith("mcp_servers="));
    if (!config.includes('"unrelated-server"={command=') || !config.includes('enabled=false}')) {
      throw new Error("broker inherited unrelated tools");
    }
    const brokerArgs = JSON.parse(/args=(\[.*?\]),required=true/.exec(config)?.[1] ?? "null");
    if (!brokerArgs) throw new Error("broker arguments missing");
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_lines", arguments: { path: "source.js", line_start: 1, line_end: 3 } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "write_file", arguments: {} } },
    ].map((request) => JSON.stringify(request)).join("\n") + "\n";
    const broker = spawnSync(process.execPath, brokerArgs, { input, encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (broker.status !== 0) throw new Error("broker transport failed");
    const replies = broker.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const read = JSON.parse(replies.find((reply) => reply.id === 3).result.content[0].text);
    if (read.path !== "source.js" || read.fingerprint_digest !== ownerFingerprint(args).digest ||
        replies.find((reply) => reply.id === 4).result.isError !== true) throw new Error("broker contract failed");
    const brokerRepo = valueAfter(brokerArgs, "--repo");
    if (scenario === "broker-unrelated-drift") {
      await fs.writeFile(path.join(brokerRepo, "unrelated.js"), `build ${Date.now()}\n`);
      await fs.writeFile(path.join(brokerRepo, "new-from-other-chat.js"), "new owner\n");
      await fs.unlink(path.join(brokerRepo, "deleted-by-other-chat.js"));
    }
    if (scenario === "broker-observed-drift-once" || scenario === "broker-observed-drift-always") {
      const marker = path.join(brokerRepo, ".drift-done");
      const happened = await fs.stat(marker).catch(() => null);
      if (!happened || scenario.endsWith("always")) {
        await fs.appendFile(path.join(brokerRepo, "source.js"), "// changed by another writer\n");
        await fs.writeFile(marker, "done");
      }
    }
  }
  const model = valueAfter(args, "-m");
  if (scenario === "gpt6-evidence-gap") {
    const effort = { "gpt-6-luna": "low", "gpt-6-sol": "medium" }[model];
    if (!effort || !args.includes(`model_reasoning_effort="${effort}"`)) {
      throw new Error("fake Codex expected the GPT-6 model and effort for this tier");
    }
    if (valueAfter(args, "--sandbox") !== "read-only") {
      throw new Error("fake Codex expected a read-only search");
    }
  }
  const invalidFlow =
    scenario === "invalid-flow-path-twice" ||
    ((scenario === "invalid-flow-path" || scenario === "broker-repair" ||
      scenario === "repair-malformed-events" ||
      scenario === "repair-missing-result") &&
      !isRepair);
  const repairedFlow =
    (scenario === "invalid-flow-path" || scenario === "broker-repair" || scenario === "repair-malformed-events") && isRepair;
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
    uncertainties:
      scenario === "gpt6-evidence-gap" && model === "gpt-6-luna"
        ? ["trigger:cross-file-gap: The fixture requires a balanced-tier evidence pass."]
        : [],
  };
  if (scenario === "broker-unobserved") result.owners[0].path = "unseen.js";
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
