import { prepareInputs } from "./rg.mjs";

let stage = "root";
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error("preparation-input-limit");
  }
  const prepared = await prepareInputs({ ...JSON.parse(input), onStage(value) {
    stage = value; process.stderr.write(JSON.stringify({ stage }) + "\n");
  } });
  process.stdout.write(JSON.stringify({ prepared }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.code ?? "preparation-unavailable",
    message: error.code ? error.message : "Repository preparation failed", details: { ...error.details, stage } } }));
  process.exitCode = 1;
}
