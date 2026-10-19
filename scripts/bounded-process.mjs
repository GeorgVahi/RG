import { spawn } from "node:child_process";

export class OperationError extends Error {
  constructor(code, details = {}) { super(code); this.name = "OperationError"; this.code = code; this.details = details; }
}

// Each process owns its children. On timeout, terminate the tree, not just its pipe.
export function runBounded(command, args, options = {}) {
  const { timeoutMs = 30_000, signal, maxBuffer = 64 * 1024 * 1024, input,
    env = process.env, cwd, onStderr, prefix = "process" } = options;
  if (signal?.aborted) return Promise.reject(new OperationError(`${prefix}-cancelled`));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new OperationError(`${prefix}-timeout`));
  return new Promise((resolve, reject) => {
    // Nested bounded Git calls stay in the outer worker's process group. Creating
    // another detached group would let Git survive termination of that worker.
    const ownsGroup = process.platform !== "win32" && process.env.RG_INTERNAL_PROCESS_GROUP !== "1";
    const child = spawn(command, args, { cwd, env: { ...env, RG_INTERNAL_PROCESS_GROUP: "1" }, windowsHide: true, detached: ownsGroup,
      stdio: ["pipe", "pipe", "pipe"] });
    let stdout = [], stderr = [], outBytes = 0, errBytes = 0, failure, settled = false, killer;
    const finish = (status) => {
      if (settled) return;
      if (failure && killer && killer.exitCode === null && !killer.killed) {
        killer.once("close", () => finish(status));
        return;
      }
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
      if (failure) reject(failure);
      else resolve({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    let killTimer;
    const stop = (code) => {
      if (failure || settled) return;
      failure = new OperationError(code);
      if (child.pid) {
        if (process.platform === "win32") {
          killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => child.kill("SIGKILL"));
        } else if (ownsGroup) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        } else child.kill("SIGKILL");
      }
      killTimer = setTimeout(() => {
        killer?.kill(); child.kill("SIGKILL"); child.stdout.destroy(); child.stderr.destroy();
        child.stdin.destroy(); finish(null);
      }, 3000);
    };
    const abort = () => stop(`${prefix}-cancelled`);
    const interrupt = () => stop(`${prefix}-cancelled`);
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    const timer = setTimeout(() => stop(`${prefix}-timeout`), Math.min(timeoutMs, 2_147_483_647));
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => { failure ??= new OperationError(`${prefix}-spawn-failed`); finish(null); });
    child.on("exit", () => {
      if (ownsGroup) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    });
    child.on("close", finish);
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBuffer) stop(`${prefix}-output-limit`); else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errBytes += chunk.length;
      if (errBytes > maxBuffer) stop(`${prefix}-output-limit`);
      else { stderr.push(chunk); onStderr?.(chunk); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
