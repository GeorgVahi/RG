import { buildCatalog, verifyObservations } from "./catalog.mjs";
import { serializeSnapshot, hydrateSnapshot, MAX_SNAPSHOT_BYTES } from "./snapshot.mjs";

try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_SNAPSHOT_BYTES) throw Object.assign(new Error(), { code: "catalog-input-limit" });
    chunks.push(chunk);
  }
  const { operation, input, maximumMs } = JSON.parse(Buffer.concat(chunks));
  const options = { maximumMs, onProgress: (metrics) => process.stderr.write(JSON.stringify(metrics) + "\n") };
  if (!["build", "verify"].includes(operation)) throw new Error();
  const snapshot = operation === "build" ? await buildCatalog(input, options) : await verifyObservations(hydrateSnapshot(input), options);
  process.stdout.write(JSON.stringify({ snapshot: serializeSnapshot(snapshot) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.code ?? "catalog-worker-failed", details: error.details ?? {} } }));
  process.exitCode = 1;
}
