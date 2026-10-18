import { buildSnapshot, serializeSnapshot } from "./snapshot.mjs";

try {
  const [repo, maximumMs] = process.argv.slice(2);
  const snapshot = await buildSnapshot(repo, { maximumMs: Number(maximumMs),
    onProgress: (metrics) => process.stderr.write(JSON.stringify(metrics) + "\n") });
  process.stdout.write(JSON.stringify({ snapshot: serializeSnapshot(snapshot) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.code ?? "fingerprint-unavailable", details: error.details ?? {} } }));
  process.exitCode = 1;
}
