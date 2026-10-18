import { spawnSync } from "node:child_process";
import { probeSandboxAccess } from "./access.mjs";

try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error();
  }
  process.stdout.write(JSON.stringify(await probeSandboxAccess({ ...JSON.parse(input), execute: spawnSync })));
} catch { process.exitCode = 1; }
