#!/usr/bin/env node

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED_PROFILES = path.join(ROOT, "profiles");
const OUTPUT_SCHEMA = path.join(ROOT, "schemas", "discovery.schema.json");
const RESULT_SCHEMA = "rg.discovery.v1";
const RUN_SCHEMA = "rg.run.v1";
const RECEIPT_SCHEMA = "rg.receipt.v1";
const INVENTORY = "git-tracked-untracked-nonignored-v1";
const INSTRUCTIONS_ID = "rg-scout-v1";
const PROFILE_NAMES = new Set(["rg_search_fast", "rg_search_balanced"]);
const ROUTE_MODES = new Set(["auto", "fast", "deep"]);
const TRIGGERS = new Set([
  "insufficient-evidence",
  "ambiguous-ownership",
  "cross-file-gap",
]);
const REASONING = new Set(["low", "medium", "high", "xhigh", "max"]);
const IGNORED_EVIDENCE_SEGMENTS = new Set([
  ".git",
  ".venv",
  ".cache",
  ".mypy_cache",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "__pycache__",
  "artifacts",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "target",
  "vendor",
]);
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_RESULT_STRING_BYTES = 32 * 1024;
const MAX_ITEMS = 64;
const MAX_FILES = 100_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FINGERPRINT_MS = 30_000;
const MAX_LINE_SPAN = 200;
const MAX_CONFIG_BYTES = 1024 * 1024;
const BLOCKED_ENV = new Set([
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "CHATGPT_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
]);

class RGError extends Error {
  constructor(message, code = "rg-error", details = {}) {
    super(message);
    this.name = "RGError";
    this.code = code;
    this.details = details;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, required, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RGError(`${context} must be an object`, "invalid-contract");
  }
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new RGError(`${context} has unknown or missing fields`, "invalid-contract");
  }
}

function assertString(value, context, maximum = 8192) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RGError(`${context} must be a non-empty string`, "invalid-contract");
  }
  if (Buffer.byteLength(value, "utf8") > maximum) {
    throw new RGError(`${context} is too large`, "invalid-contract");
  }
  return value;
}

function codexHome() {
  const configured = process.env.CODEX_HOME;
  return path.resolve(configured && configured.trim() ? configured : path.join(os.homedir(), ".codex"));
}

function runGit(repo, args, options = {}) {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: options.encoding ?? null,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString("utf8").trim()
      : String(error.stderr ?? "").trim();
    throw new RGError(
      `Git command failed${stderr ? `: ${stderr.split(/\r?\n/, 1)[0]}` : ""}`,
      "git-failed",
    );
  }
}

function resolveGitRoot(candidate) {
  const resolved = path.resolve(candidate || process.cwd());
  const output = runGit(resolved, ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return path.resolve(output.trim());
}

function decodeUtf8(buffer, context) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new RGError(`${context} is not UTF-8`, "invalid-path");
  }
}

function assertSafeRelative(relative, context = "path") {
  assertString(relative, context, 1024);
  if (relative.includes("\\") || relative.includes("\0")) {
    throw new RGError(`${context} contains an unsafe separator`, "invalid-path");
  }
  const normalized = path.posix.normalize(relative);
  if (
    normalized !== relative ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new RGError(`${context} is unsafe`, "invalid-path");
  }
  return normalized;
}

function inventoryPaths(repo) {
  const tracked = runGit(repo, ["ls-files", "-z", "--cached"]);
  const untracked = runGit(repo, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const combined = Buffer.concat([tracked, untracked]);
  const decoded = decodeUtf8(combined, "Git inventory");
  const unique = new Set();
  for (const entry of decoded.split("\0")) {
    if (!entry) continue;
    unique.add(assertSafeRelative(entry, "Git inventory path"));
  }
  const paths = [...unique].sort((left, right) =>
    Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")),
  );
  if (paths.length > MAX_FILES) {
    throw new RGError("fingerprint file limit exceeded", "fingerprint-unavailable");
  }
  return paths;
}

function hashField(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

async function hashRegularFile(hash, filePath, deadline) {
  let size = 0;
  let newlines = 0;
  let lastByte = null;
  const stream = fs.createReadStream(filePath, { flags: fs.constants.O_RDONLY });
  for await (const chunk of stream) {
    if (Date.now() > deadline) {
      stream.destroy();
      throw new RGError("fingerprint time limit exceeded", "fingerprint-unavailable");
    }
    size += chunk.length;
    if (size > MAX_BYTES) {
      stream.destroy();
      throw new RGError("fingerprint byte limit exceeded", "fingerprint-unavailable");
    }
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] === 10) newlines += 1;
    }
    if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
    hash.update(chunk);
  }
  const lines = size === 0 ? 1 : newlines + (lastByte === 10 ? 0 : 1);
  return { size, lines: Math.max(lines, 1) };
}

async function computeFingerprint(repo, limits = {}) {
  const maximumMs = limits.maximumMs ?? MAX_FINGERPRINT_MS;
  const deadline = Date.now() + maximumMs;
  const paths = inventoryPaths(repo);
  const hash = createHash("sha256");
  hash.update("rg-worktree-fingerprint-v1\0", "utf8");
  const lineCounts = new Map();
  let bytes = 0;

  for (const relative of paths) {
    if (Date.now() > deadline) {
      throw new RGError("fingerprint time limit exceeded", "fingerprint-unavailable");
    }
    const full = path.resolve(repo, ...relative.split("/"));
    const boundary = `${path.resolve(repo)}${path.sep}`;
    if (full !== path.resolve(repo) && !full.startsWith(boundary)) {
      throw new RGError("fingerprint path escaped repository", "fingerprint-unavailable");
    }
    let info;
    try {
      info = await fsp.lstat(full);
    } catch {
      throw new RGError("fingerprint inventory entry disappeared", "fingerprint-unavailable");
    }
    hashField(hash, relative);
    if (info.isFile()) {
      hashField(hash, "file");
      const measured = await hashRegularFile(hash, full, deadline);
      bytes += measured.size;
      lineCounts.set(relative, measured.lines);
    } else if (info.isSymbolicLink()) {
      hashField(hash, "symlink");
      const target = await fsp.readlink(full);
      const targetBytes = Buffer.from(target, "utf8");
      hashField(hash, targetBytes);
      bytes += targetBytes.length;
      lineCounts.set(relative, 0);
    } else if (info.isDirectory()) {
      hashField(hash, "gitlink");
      const head = runGit(full, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const status = runGit(full, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
      hashField(hash, head);
      hashField(hash, status);
      bytes += Buffer.byteLength(head, "utf8") + status.length;
      lineCounts.set(relative, 0);
    } else {
      throw new RGError("fingerprint found an unsupported special file", "fingerprint-unavailable");
    }
    if (bytes > MAX_BYTES) {
      throw new RGError("fingerprint byte limit exceeded", "fingerprint-unavailable");
    }
  }

  const inventoryAgain = inventoryPaths(repo);
  if (!isDeepStrictEqual(paths, inventoryAgain)) {
    throw new RGError("Git inventory changed during fingerprint", "fingerprint-drift");
  }
  return {
    public: {
      algorithm: "sha256",
      digest: hash.digest("hex"),
      files: paths.length,
      bytes,
      inventory: INVENTORY,
    },
    paths: new Set(paths),
    lineCounts,
  };
}

async function assertNoLinkedEvidencePath(repo, relative) {
  const segments = relative.split("/");
  let current = path.resolve(repo);
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await fsp.lstat(current);
    if (info.isSymbolicLink()) {
      throw new RGError("evidence path contains a symlink or junction", "invalid-result");
    }
  }
}

function validateFingerprint(value, expected) {
  exactKeys(value, ["algorithm", "digest", "files", "bytes", "inventory"], "fingerprint");
  if (
    value.algorithm !== "sha256" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !Number.isInteger(value.files) ||
    !Number.isInteger(value.bytes) ||
    value.inventory !== INVENTORY
  ) {
    throw new RGError("result fingerprint is malformed", "invalid-result");
  }
  if (!isDeepStrictEqual(value, expected.public)) {
    throw new RGError("result fingerprint does not match owner snapshot", "invalid-result");
  }
}

async function validateEvidencePath(repo, snapshot, relative, context) {
  const safe = assertSafeRelative(relative, context);
  if (!snapshot.paths.has(safe)) {
    throw new RGError(`${context} is outside the fingerprint inventory`, "invalid-result");
  }
  const segments = safe.split("/");
  if (segments.some((segment) => IGNORED_EVIDENCE_SEGMENTS.has(segment))) {
    throw new RGError(`${context} points to ignored generated or dependency content`, "invalid-result");
  }
  await assertNoLinkedEvidencePath(repo, safe);
  return safe;
}

async function validateEvidenceArray(name, value, repo, snapshot) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new RGError(`${name} has an invalid item count`, "invalid-result");
  }
  if (name === "owners" && value.length === 0) {
    throw new RGError("owners must contain at least one evidence item", "invalid-result");
  }
  const allowed = new Set([
    "path",
    "line_start",
    "line_end",
    "symbol",
    "reason",
    "kind",
    "related_path",
  ]);
  const required = allowed;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RGError(`${name}[${index}] must be an object`, "invalid-result");
    }
    const keys = Object.keys(item);
    if (keys.some((key) => !allowed.has(key)) || [...required].some((key) => !(key in item))) {
      throw new RGError(`${name}[${index}] has invalid fields`, "invalid-result");
    }
    const relative = await validateEvidencePath(repo, snapshot, item.path, `${name}[${index}].path`);
    if (
      !Number.isInteger(item.line_start) ||
      !Number.isInteger(item.line_end) ||
      item.line_start < 1 ||
      item.line_end < item.line_start ||
      item.line_end - item.line_start + 1 > MAX_LINE_SPAN
    ) {
      throw new RGError(`${name}[${index}] has an invalid line range`, "invalid-result");
    }
    const lines = snapshot.lineCounts.get(relative) ?? 0;
    if (lines < item.line_end) {
      throw new RGError(`${name}[${index}] line range exceeds the file`, "invalid-result");
    }
    assertString(item.symbol, `${name}[${index}].symbol`, 512);
    assertString(item.reason, `${name}[${index}].reason`, 2000);
    if (item.kind !== null) assertString(item.kind, `${name}[${index}].kind`, 128);
    if (item.related_path !== null) {
      await validateEvidencePath(
        repo,
        snapshot,
        item.related_path,
        `${name}[${index}].related_path`,
      );
    }
  }
}

function validateStringArray(name, value) {
  if (!Array.isArray(value) || value.length > 32) {
    throw new RGError(`${name} has an invalid item count`, "invalid-result");
  }
  for (let index = 0; index < value.length; index += 1) {
    assertString(value[index], `${name}[${index}]`, 2000);
  }
}

function extractTriggers(uncertainties) {
  const triggers = [];
  for (const uncertainty of uncertainties) {
    if (!uncertainty.startsWith("trigger:")) continue;
    const match = /^trigger:([a-z-]+):\s*(.+)$/s.exec(uncertainty);
    if (!match || !TRIGGERS.has(match[1])) {
      throw new RGError("result contains an invalid escalation trigger", "invalid-result");
    }
    if (!triggers.includes(match[1])) triggers.push(match[1]);
  }
  return triggers;
}

async function validateResultObject(value, repo, snapshot) {
  exactKeys(
    value,
    [
      "schema",
      "worktree_fingerprint",
      "summary",
      "owners",
      "couplings",
      "tests",
      "flows",
      "constraints",
      "uncertainties",
    ],
    "discovery result",
  );
  if (value.schema !== RESULT_SCHEMA) {
    throw new RGError(`result schema must be ${RESULT_SCHEMA}`, "invalid-result");
  }
  validateFingerprint(value.worktree_fingerprint, snapshot);
  assertString(value.summary, "summary", 8192);
  await validateEvidenceArray("owners", value.owners, repo, snapshot);
  await validateEvidenceArray("couplings", value.couplings, repo, snapshot);
  await validateEvidenceArray("tests", value.tests, repo, snapshot);
  await validateEvidenceArray("flows", value.flows, repo, snapshot);
  validateStringArray("constraints", value.constraints);
  validateStringArray("uncertainties", value.uncertainties);
  const stringBudget = Buffer.byteLength(
    [
      value.summary,
      ...value.constraints,
      ...value.uncertainties,
      ...[value.owners, value.couplings, value.tests, value.flows]
        .flat()
        .flatMap((item) => [item.symbol, item.reason, item.kind ?? ""]),
    ].join("\0"),
    "utf8",
  );
  if (stringBudget > MAX_RESULT_STRING_BYTES) {
    throw new RGError("result string budget exceeded", "invalid-result");
  }
  return extractTriggers(value.uncertainties);
}

async function readAndValidateResult(resultFile, repo, snapshot) {
  const info = await fsp.stat(resultFile).catch(() => null);
  if (!info || !info.isFile() || info.size === 0 || info.size > MAX_RESULT_BYTES) {
    throw new RGError("result artifact is missing, empty, or too large", "invalid-result");
  }
  const raw = await fsp.readFile(resultFile);
  let value;
  try {
    value = JSON.parse(decodeUtf8(raw, "result artifact"));
  } catch (error) {
    if (error instanceof RGError) throw error;
    throw new RGError("result artifact is not strict JSON", "invalid-result");
  }
  const triggers = await validateResultObject(value, repo, snapshot);
  return { value, triggers };
}

async function readJson(file, context) {
  const info = await fsp.stat(file).catch(() => null);
  if (!info || !info.isFile() || info.size === 0 || info.size > MAX_CONFIG_BYTES) {
    throw new RGError(`${context} is missing, empty, or too large`, "invalid-configuration");
  }
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    throw new RGError(`${context} is not valid JSON`, "invalid-configuration");
  }
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    const info = await fsp.stat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  return null;
}

function validateProfile(value, expectedName, source) {
  exactKeys(
    value,
    [
      "name",
      "description",
      "model",
      "model_reasoning_effort",
      "sandbox_mode",
      "instructions_id",
    ],
    `profile ${expectedName}`,
  );
  if (value.name !== expectedName || !PROFILE_NAMES.has(value.name)) {
    throw new RGError(`profile ${expectedName} changed its canonical name`, "invalid-configuration");
  }
  assertString(value.description, `profile ${expectedName} description`, 1024);
  if (typeof value.model !== "string" || !/^[a-z0-9][a-z0-9._-]+$/.test(value.model)) {
    throw new RGError(`profile ${expectedName} has an invalid model`, "invalid-configuration");
  }
  if (!REASONING.has(value.model_reasoning_effort)) {
    throw new RGError(`profile ${expectedName} has an invalid reasoning effort`, "invalid-configuration");
  }
  if (value.sandbox_mode !== "read-only" || value.instructions_id !== INSTRUCTIONS_ID) {
    throw new RGError(
      `profile ${expectedName} changed the read-only scout contract`,
      "invalid-configuration",
    );
  }
  return { ...value, source };
}

async function loadProfile(name, repo, home = codexHome()) {
  if (!PROFILE_NAMES.has(name)) {
    throw new RGError(`unsupported RG profile ${name}`, "invalid-configuration");
  }
  const filename = `${name}.json`;
  const source = await firstExisting([
    path.join(repo, ".codex", "rg", "profiles", filename),
    path.join(home, "rg", "profiles", filename),
    path.join(PACKAGED_PROFILES, filename),
  ]);
  if (!source) throw new RGError(`profile ${name} is missing`, "invalid-configuration");
  return validateProfile(await readJson(source, `profile ${name}`), name, source);
}

function validateRoute(name, value) {
  exactKeys(
    value,
    [
      "agents",
      "max_steps",
      "escalation_mode",
      "escalation_triggers",
      "stop_on_success",
      "transport_failure",
      "fallback",
    ],
    `route ${name}`,
  );
  const canonicalAgents = {
    auto: ["rg_search_fast", "rg_search_balanced"],
    fast: ["rg_search_fast"],
    deep: ["rg_search_balanced"],
  }[name];
  if (!isDeepStrictEqual(value.agents, canonicalAgents)) {
    throw new RGError(`route ${name} changed its canonical agent order`, "invalid-configuration");
  }
  if (!Number.isInteger(value.max_steps) || value.max_steps !== canonicalAgents.length) {
    throw new RGError(`route ${name} has an invalid max_steps`, "invalid-configuration");
  }
  if (
    value.escalation_mode !== "after-evidence" ||
    value.stop_on_success !== true ||
    value.transport_failure !== "block" ||
    value.fallback !== "targeted-root"
  ) {
    throw new RGError(`route ${name} weakened routing invariants`, "invalid-configuration");
  }
  if (
    !Array.isArray(value.escalation_triggers) ||
    value.escalation_triggers.some((trigger) => !TRIGGERS.has(trigger))
  ) {
    throw new RGError(`route ${name} has invalid escalation triggers`, "invalid-configuration");
  }
  return value;
}

function validateModelMap(value, source) {
  exactKeys(value, ["schema_version", "name", "routes"], "model map");
  if (value.schema_version !== 1) {
    throw new RGError("model map schema_version must be 1", "invalid-configuration");
  }
  assertString(value.name, "model map name", 512);
  exactKeys(value.routes, ["auto", "fast", "deep"], "model map routes");
  const routes = {};
  for (const name of ROUTE_MODES) routes[name] = validateRoute(name, value.routes[name]);
  return {
    value: { ...value, routes },
    source,
    sha256: sha256(canonicalJson(value)),
  };
}

async function loadModelMap(repo, home = codexHome()) {
  const source = await firstExisting([
    path.join(repo, ".codex", "rg", "model-map.json"),
    path.join(home, "rg", "model-map.json"),
    path.join(PACKAGED_PROFILES, "model-map.json"),
  ]);
  if (!source) throw new RGError("RG model map is missing", "invalid-configuration");
  return validateModelMap(await readJson(source, "model map"), source);
}

async function resolveRoute(repo, mode, home = codexHome()) {
  if (!ROUTE_MODES.has(mode)) throw new RGError(`unsupported mode ${mode}`, "invalid-arguments");
  const map = await loadModelMap(repo, home);
  const route = map.value.routes[mode];
  const profiles = [];
  for (const name of route.agents.slice(0, route.max_steps)) {
    profiles.push(await loadProfile(name, repo, home));
  }
  return { map, route, profiles };
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && (quote === null || quote === char)) {
      quote = quote === char ? null : char;
      continue;
    }
    if (char === "#" && quote === null) return line.slice(0, index);
  }
  return line;
}

function tomlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function validateSubscriptionConfig(file) {
  const info = await fsp.stat(file).catch(() => null);
  if (!info) return;
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
    throw new RGError("Codex config is not a bounded regular file", "invalid-configuration");
  }
  const text = await fsp.readFile(file, "utf8");
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (/^model_providers\.openai$/i.test(section)) {
        throw new RGError(
          `${file}: custom model_providers.openai is not allowed for subscription dispatch`,
          "invalid-configuration",
        );
      }
      continue;
    }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment || section) continue;
    const key = assignment[1];
    const value = tomlScalar(assignment[2]);
    if (key === "model_provider" && value !== "openai") {
      throw new RGError(
        `${file}: model_provider must be openai for subscription dispatch`,
        "invalid-configuration",
      );
    }
    if ((key === "openai_base_url" || key === "chatgpt_base_url") && value) {
      throw new RGError(`${file}: provider redirects are not allowed`, "invalid-configuration");
    }
  }
}

async function subscriptionConfigPaths(repo, home = codexHome()) {
  const candidates = [path.join(home, "config.toml")];
  let current = path.resolve(repo);
  while (true) {
    candidates.push(path.join(current, ".codex", "config.toml"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

async function validateSubscriptionConfiguration(repo, home = codexHome()) {
  for (const file of await subscriptionConfigPaths(repo, home)) {
    await validateSubscriptionConfig(file);
  }
}

function scrubEnvironment(environment = process.env) {
  const cleaned = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!BLOCKED_ENV.has(key.toUpperCase())) cleaned[key] = value;
  }
  return cleaned;
}

function requireChatGPTLogin(codexBin, environment) {
  const result = spawnSync(codexBin, ["login", "status"], {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
    timeout: 30_000,
  });
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0 || !combined.includes("ChatGPT")) {
    const summary = combined.split(/\r?\n/, 1)[0] || result.error?.message || `exit ${result.status}`;
    throw new RGError(
      `RG requires Codex CLI authentication through ChatGPT; login status: ${summary}`,
      "chatgpt-auth-unavailable",
    );
  }
  return "chatgpt";
}

function tomlString(value) {
  return JSON.stringify(value);
}

function developerInstructions(profile, fingerprint) {
  const tier = profile.name === "rg_search_fast" ? "fast Luna step" : "balanced Terra step";
  return `You are the already-delegated read-only RG repository scout (${tier}). Do not spawn or delegate to another agent.

Perform the bounded repository search yourself with rg, rg --files, focused file reads, and Git metadata only when it supports the requested map. Never edit files, write configuration, run destructive commands, commit, push, access secrets, make product decisions, or answer the end user.

Return exactly one UTF-8 JSON object matching schema rg.discovery.v1 and no Markdown fences or surrounding prose. Copy this owner-provided worktree_fingerprint exactly:
${canonicalJson(fingerprint)}

Use exactly these top-level fields: schema, worktree_fingerprint, summary, owners, couplings, tests, flows, constraints, uncertainties. Evidence arrays contain flat items with path, line_start, line_end, symbol, reason, kind, and related_path. Set kind or related_path to null when not applicable. Keep paths repository-relative with forward slashes and line ranges tight (maximum 200 lines). Owners must be non-empty. Cite source, tests, configuration, and documentation only when each item directly supports the requested map. Do not cite .git, generated output, vendor, dependency, cache, coverage, dist, target, or artifact paths.

Search until the request is answered or a concrete evidence gap remains. On the fast Luna step only, if the map cannot be made reliable at this tier after a real bounded search, add one uncertainty formatted exactly as trigger:<trigger>: <specific reason>, where <trigger> is insufficient-evidence, ambiguous-ownership, or cross-file-gap. Do not request escalation merely to save work. On the balanced Terra step, preserve unresolved facts as ordinary uncertainties without a trigger prefix. Keep raw logs and large file dumps out of the result.`;
}

function buildCodexArgs(profile, repo, resultFile, instructions) {
  return [
    "exec",
    "--json",
    "--color",
    "never",
    "--ephemeral",
    "-m",
    profile.model,
    "-c",
    `model_reasoning_effort=${tomlString(profile.model_reasoning_effort)}`,
    "-c",
    `developer_instructions=${tomlString(instructions)}`,
    "-c",
    "features.multi_agent=false",
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'model_provider="openai"',
    "--sandbox",
    "read-only",
    "--output-schema",
    path.resolve(OUTPUT_SCHEMA),
    "-C",
    path.resolve(repo),
    "-o",
    path.resolve(resultFile),
    "-",
  ];
}

async function atomicWriteJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fsp.rename(temporary, file);
}

function createRunId(profileName) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `${timestamp}-${profileName}-${randomBytes(6).toString("hex")}`;
}

function parseTerminalEvents(text) {
  let terminal = null;
  let threadId = null;
  let explicitError = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new RGError("Codex JSONL contains malformed JSON", "runner-failed");
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      threadId = event.thread_id;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") terminal = event.type;
    if (event.type === "error" && !explicitError) {
      explicitError = typeof event.message === "string" ? event.message : "Codex emitted an error event";
    }
  }
  return { terminal, threadId, explicitError };
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 15_000,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already stopped.
    }
  }
}

async function runCodex({ codexBin, args, prompt, environment, eventsFile, stderrFile, timeoutMs }) {
  const eventFd = fs.openSync(eventsFile, "wx", 0o600);
  const stderrFd = fs.openSync(stderrFile, "wx", 0o600);
  let child;
  let timedOut = false;
  try {
    child = spawn(codexBin, args, {
      cwd: process.cwd(),
      env: environment,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", eventFd, stderrFd],
    });
  } catch (error) {
    fs.closeSync(eventFd);
    fs.closeSync(stderrFd);
    throw new RGError(`cannot start Codex CLI: ${error.message}`, "spawn-failed");
  }
  child.stdin.on("error", () => {});
  child.stdin.end(prompt, "utf8");
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child);
  }, timeoutMs);
  let outcome;
  try {
    outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    throw new RGError(`Codex process failed to start: ${error.message}`, "spawn-failed");
  } finally {
    clearTimeout(timer);
    fs.closeSync(eventFd);
    fs.closeSync(stderrFd);
  }
  if (timedOut) throw new RGError("Codex search timed out", "worker-timeout");
  return outcome;
}

async function runProfile({ profile, repo, query, map, codexBin, timeoutMs, expectedFingerprint }) {
  const pre = await computeFingerprint(repo);
  if (expectedFingerprint && !isDeepStrictEqual(pre.public, expectedFingerprint)) {
    throw new RGError("worktree drifted before the next route step", "fingerprint-drift");
  }
  const home = codexHome();
  const runId = createRunId(profile.name);
  const runDir = path.join(home, "rg", "runs", runId);
  await fsp.mkdir(runDir, { recursive: true, mode: 0o700 });
  const resultFile = path.join(runDir, "result.json");
  const eventsFile = path.join(runDir, "events.jsonl");
  const stderrFile = path.join(runDir, "stderr.log");
  const receiptFile = path.join(runDir, "receipt.json");
  const promptFile = path.join(runDir, "prompt.txt");
  const instructions = developerInstructions(profile, pre.public);
  const prompt = `Repository discovery request:\n${query.trim()}\n`;
  const args = buildCodexArgs(profile, repo, resultFile, instructions);
  const startedAt = new Date().toISOString();
  await fsp.writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await atomicWriteJson(receiptFile, {
    schema: RECEIPT_SCHEMA,
    status: "running",
    run_id: runId,
    configured_profile: profile.name,
    configured_model: profile.model,
    model_reasoning_effort: profile.model_reasoning_effort,
    sandbox: "read-only",
    auth_mode: "chatgpt",
    dispatch_method: "codex-exec-explicit-model",
    prompt_sha256: sha256(prompt),
    instructions_sha256: sha256(instructions),
    model_map_sha256: map.sha256,
    worktree_fingerprint: pre.public,
    started_at: startedAt,
    completed_at: null,
    terminal_event: null,
    codex_exit_code: null,
    result_evidence: "missing",
  });

  process.stderr.write(`RG: starting ${profile.name} (${profile.model}/${profile.model_reasoning_effort})\n`);
  const environment = scrubEnvironment(process.env);
  let outcome;
  try {
    outcome = await runCodex({
      codexBin,
      args,
      prompt,
      environment,
      eventsFile,
      stderrFile,
      timeoutMs,
    });
  } catch (error) {
    await atomicWriteJson(receiptFile, {
      schema: RECEIPT_SCHEMA,
      status: "failed",
      run_id: runId,
      configured_profile: profile.name,
      configured_model: profile.model,
      model_reasoning_effort: profile.model_reasoning_effort,
      sandbox: "read-only",
      auth_mode: "chatgpt",
      dispatch_method: "codex-exec-explicit-model",
      prompt_sha256: sha256(prompt),
      instructions_sha256: sha256(instructions),
      model_map_sha256: map.sha256,
      worktree_fingerprint: pre.public,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      terminal_event: null,
      codex_exit_code: null,
      result_evidence: "missing",
      failure_reason: error.code ?? "runner-failed",
    });
    error.details = { ...(error.details ?? {}), receipt: receiptFile };
    throw error;
  }

  const eventsText = await fsp.readFile(eventsFile, "utf8");
  const terminal = parseTerminalEvents(eventsText);
  const stderrText = await fsp.readFile(stderrFile, "utf8");
  if (outcome.code !== 0 || terminal.terminal !== "turn.completed" || terminal.explicitError) {
    const reason = terminal.terminal === "turn.failed" ? "turn-failed" : "runner-failed";
    const summary = terminal.explicitError || stderrText.trim().split(/\r?\n/, 1)[0] || `exit ${outcome.code}`;
    await atomicWriteJson(receiptFile, {
      schema: RECEIPT_SCHEMA,
      status: "failed",
      run_id: runId,
      configured_profile: profile.name,
      configured_model: profile.model,
      model_reasoning_effort: profile.model_reasoning_effort,
      sandbox: "read-only",
      auth_mode: "chatgpt",
      dispatch_method: "codex-exec-explicit-model",
      prompt_sha256: sha256(prompt),
      instructions_sha256: sha256(instructions),
      model_map_sha256: map.sha256,
      worktree_fingerprint: pre.public,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      terminal_event: terminal.terminal,
      codex_exit_code: outcome.code,
      result_evidence: "missing",
      failure_reason: reason,
    });
    throw new RGError(`exact model run failed: ${summary}`, reason, { receipt: receiptFile });
  }

  let post;
  let validated;
  try {
    post = await computeFingerprint(repo);
    if (!isDeepStrictEqual(pre.public, post.public)) {
      throw new RGError("worktree fingerprint drifted during read-only search", "fingerprint-drift");
    }
    validated = await readAndValidateResult(resultFile, repo, post);
  } catch (error) {
    await atomicWriteJson(receiptFile, {
      schema: RECEIPT_SCHEMA,
      status: "failed",
      run_id: runId,
      configured_profile: profile.name,
      configured_model: profile.model,
      model_reasoning_effort: profile.model_reasoning_effort,
      sandbox: "read-only",
      auth_mode: "chatgpt",
      dispatch_method: "codex-exec-explicit-model",
      prompt_sha256: sha256(prompt),
      instructions_sha256: sha256(instructions),
      model_map_sha256: map.sha256,
      worktree_fingerprint: pre.public,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      terminal_event: terminal.terminal,
      codex_exit_code: outcome.code,
      result_evidence: error.code === "invalid-result" ? "invalid" : "missing",
      failure_reason: error.code ?? "runner-failed",
    });
    error.details = { ...(error.details ?? {}), receipt: receiptFile };
    throw error;
  }
  const completedAt = new Date().toISOString();
  await atomicWriteJson(receiptFile, {
    schema: RECEIPT_SCHEMA,
    status: "completed",
    run_id: runId,
    configured_profile: profile.name,
    configured_model: profile.model,
    model_reasoning_effort: profile.model_reasoning_effort,
    sandbox: "read-only",
    auth_mode: "chatgpt",
    dispatch_method: "codex-exec-explicit-model",
    prompt_sha256: sha256(prompt),
    instructions_sha256: sha256(instructions),
    model_map_sha256: map.sha256,
    worktree_fingerprint: post.public,
    started_at: startedAt,
    completed_at: completedAt,
    terminal_event: terminal.terminal,
    codex_exit_code: outcome.code,
    result_evidence: "valid",
    observed_model: profile.model,
    observed_reasoning_effort: profile.model_reasoning_effort,
    thread_id_sha256: terminal.threadId ? sha256(terminal.threadId) : null,
    escalation_triggers: validated.triggers,
  });
  process.stderr.write(`RG: completed ${profile.name}; triggers=${validated.triggers.join(",") || "none"}\n`);
  return {
    profile,
    fingerprint: post.public,
    result: validated.value,
    triggers: validated.triggers,
    receipt: receiptFile,
  };
}

async function executeResolvedRoute({
  resolved,
  root,
  query,
  codexBin,
  timeoutMs,
  runStep = runProfile,
}) {
  const steps = [];
  let current = null;
  let initialFingerprint = null;

  for (let index = 0; index < resolved.profiles.length; index += 1) {
    const profile = resolved.profiles[index];
    current = await runStep({
      profile,
      repo: root,
      query,
      map: resolved.map,
      codexBin,
      timeoutMs,
      expectedFingerprint: initialFingerprint,
    });
    if (!initialFingerprint) initialFingerprint = current.fingerprint;
    steps.push({
      profile: profile.name,
      model: profile.model,
      reasoning_effort: profile.model_reasoning_effort,
      result: "completed",
      triggers: current.triggers,
      receipt: current.receipt,
    });
    if (current.triggers.length === 0) break;
    const allowed = new Set(resolved.route.escalation_triggers);
    if (current.triggers.some((trigger) => !allowed.has(trigger))) break;
    if (index + 1 >= resolved.profiles.length) break;
  }
  return { current, steps };
}

async function performSearch({ repo, query, mode = "auto", codexBin = "codex", timeoutMs = 900_000 }) {
  const root = resolveGitRoot(repo);
  assertString(query.trim(), "query", 32 * 1024);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 1_800_000) {
    throw new RGError("timeout must be between 30 and 1800 seconds", "invalid-arguments");
  }
  const home = codexHome();
  await validateSubscriptionConfiguration(root, home);
  const environment = scrubEnvironment(process.env);
  requireChatGPTLogin(codexBin, environment);
  const resolved = await resolveRoute(root, mode, home);
  const { current, steps } = await executeResolvedRoute({
    resolved,
    root,
    query,
    codexBin,
    timeoutMs,
  });

  const status = current.triggers.length === 0 ? "completed" : "completed_with_gaps";
  return {
    schema: RUN_SCHEMA,
    status,
    mode,
    model_map: {
      sha256: resolved.map.sha256,
      source: path.relative(root, resolved.map.source).replaceAll("\\", "/") || ".",
    },
    steps,
    result: current.result,
  };
}

function parseCli(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).replaceAll("-", "_");
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return { command, options, positional };
}

function publicProfile(profile) {
  return {
    name: profile.name,
    model: profile.model,
    model_reasoning_effort: profile.model_reasoning_effort,
    sandbox_mode: profile.sandbox_mode,
    source: profile.source,
  };
}

async function doctor(repo, codexBin = "codex") {
  const root = resolveGitRoot(repo);
  const home = codexHome();
  await validateSubscriptionConfiguration(root, home);
  const auth = requireChatGPTLogin(codexBin, scrubEnvironment(process.env));
  const resolved = await resolveRoute(root, "auto", home);
  const fingerprint = await computeFingerprint(root);
  return {
    schema: "rg.doctor.v1",
    status: "ok",
    repo: root,
    node: process.version,
    auth_mode: auth,
    model_map_sha256: resolved.map.sha256,
    profiles: resolved.profiles.map(publicProfile),
    worktree_fingerprint: fingerprint.public,
  };
}

function help() {
  return `RG exact-model repository search

Usage:
  node scripts/rg.mjs search --repo <path> --query <request> [--mode auto|fast|deep] [--timeout <seconds>]
  node scripts/rg.mjs doctor --repo <path>
  node scripts/rg.mjs resolve --repo <path> [--mode auto|fast|deep]
`;
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(help());
    return;
  }
  const repo = options.repo || process.cwd();
  const codexBin = options.codex_bin || process.env.RG_CODEX_BIN || "codex";
  if (command === "search") {
    const mode = options.mode || "auto";
    const timeoutMs = Number(options.timeout ?? 900) * 1000;
    const result = await performSearch({
      repo,
      query: String(options.query ?? ""),
      mode,
      codexBin,
      timeoutMs,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "doctor") {
    process.stdout.write(`${JSON.stringify(await doctor(repo, codexBin), null, 2)}\n`);
    return;
  }
  if (command === "resolve") {
    const root = resolveGitRoot(repo);
    const resolved = await resolveRoute(root, options.mode || "auto");
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: "rg.resolve.v1",
          mode: options.mode || "auto",
          model_map_sha256: resolved.map.sha256,
          route: resolved.route,
          profiles: resolved.profiles.map(publicProfile),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  throw new RGError(`unknown command ${command}`, "invalid-arguments");
}

export {
  RGError,
  buildCodexArgs,
  canonicalJson,
  computeFingerprint,
  executeResolvedRoute,
  extractTriggers,
  performSearch,
  resolveGitRoot,
  resolveRoute,
  scrubEnvironment,
  validateModelMap,
  validateProfile,
  validateResultObject,
  validateSubscriptionConfig,
};

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main().catch((error) => {
    const code = error instanceof RGError ? error.code : "unexpected-error";
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({ schema: RUN_SCHEMA, status: "failed", failure_reason: code, message }, null, 2)}\n`,
    );
    process.exitCode = 1;
  });
}
