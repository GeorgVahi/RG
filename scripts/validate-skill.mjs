#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateModelMap, validateProfile } from "./rg.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "SKILL.md",
  "agents/openai.yaml",
  "profiles/model-map.json",
  "profiles/rg_search_fast.json",
  "profiles/rg_search_balanced.json",
  "schemas/discovery.schema.json",
  "scripts/rg.mjs",
  "scripts/canary.mjs",
  "tests/rg.test.mjs",
  "tests/rg.integration.test.mjs",
  "tests/fixtures/fake-codex.mjs",
  ".github/workflows/ci.yml",
  "claude-code/agents/Explore.md",
  "claude-code/CLAUDE.md",
];

for (const relative of required) {
  const info = await fs.stat(path.join(root, relative)).catch(() => null);
  if (!info?.isFile()) throw new Error(`required regular file is missing: ${relative}`);
}

const skill = await fs.readFile(path.join(root, "SKILL.md"), "utf8");
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
if (!frontmatter) throw new Error("SKILL.md must begin with YAML frontmatter");
if (!/^name:\s*rg\s*$/m.test(frontmatter[1])) throw new Error("skill name must be rg");
const description = /^description:\s*(.+)$/m.exec(frontmatter[1])?.[1]?.trim();
if (!description || description.length > 1024) {
  throw new Error("skill description must be present and at most 1024 characters");
}
for (const requiredInstruction of [
  "`session_id`",
  "`write_stdin`",
  "terminal `exit_code`",
  "final `rg.run.v1`",
  "`rg.status.v1`",
  "`fallback_allowed: true`",
]) {
  if (!skill.includes(requiredInstruction)) {
    throw new Error(`SKILL.md must retain live-session handling instruction: ${requiredInstruction}`);
  }
}

const runner = await fs.readFile(path.join(root, "scripts", "rg.mjs"), "utf8");
if (!runner.includes("still running; wait for final rg.run.v1")) {
  throw new Error("scripts/rg.mjs must retain the live-session progress hint");
}
for (const requiredRunnerToken of [
  'const STATUS_SCHEMA = "rg.status.v1"',
  'const PROGRESS_SCHEMA = "rg.progress.v1"',
  "polling_windows_affect_state: false",
  'fallbackAllowed: true',
]) {
  if (!runner.includes(requiredRunnerToken)) {
    throw new Error(`scripts/rg.mjs must retain terminal-only status behavior: ${requiredRunnerToken}`);
  }
}

const openai = await fs.readFile(path.join(root, "agents", "openai.yaml"), "utf8");
if (!/allow_implicit_invocation:\s*true/.test(openai)) {
  throw new Error("agents/openai.yaml must enable implicit invocation");
}
if (!/default_prompt:[^\r\n]*\$rg/.test(openai)) {
  throw new Error("agents/openai.yaml default_prompt must mention $rg");
}

const scout = await fs.readFile(path.join(root, "claude-code", "agents", "Explore.md"), "utf8");
const scoutFrontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(scout)?.[1];
if (!scoutFrontmatter) throw new Error("claude-code/agents/Explore.md must begin with YAML frontmatter");
if (!/^name:\s*Explore\s*$/m.test(scoutFrontmatter)) {
  throw new Error("Claude Code scout must be named Explore so it overrides the built-in agent");
}
if (!/^model:\s*\S+\s*$/m.test(scoutFrontmatter) || /^model:\s*inherit\s*$/m.test(scoutFrontmatter)) {
  throw new Error("Claude Code scout must pin an explicit model");
}
const scoutTools = /^tools:\s*(.+)$/m.exec(scoutFrontmatter)?.[1].split(",").map((tool) => tool.trim());
if (!scoutTools || scoutTools.some((tool) => !["Read", "Grep", "Glob"].includes(tool))) {
  throw new Error("Claude Code scout must stay read-only: tools may only be Read, Grep, Glob");
}
if (!scout.includes("escalate:")) {
  throw new Error("Claude Code scout must retain the escalate: evidence-gap contract");
}
const routing = await fs.readFile(path.join(root, "claude-code", "CLAUDE.md"), "utf8");
for (const requiredRoutingToken of ["Explore", "escalate:", "sonnet"]) {
  if (!routing.includes(requiredRoutingToken)) {
    throw new Error(`claude-code/CLAUDE.md must retain routing instruction: ${requiredRoutingToken}`);
  }
}

const readJson = async (relative) => JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
const fastFile = "profiles/rg_search_fast.json";
const balancedFile = "profiles/rg_search_balanced.json";
validateProfile(await readJson(fastFile), "rg_search_fast", fastFile);
validateProfile(await readJson(balancedFile), "rg_search_balanced", balancedFile);
validateModelMap(await readJson("profiles/model-map.json"), "profiles/model-map.json");

const schema = await readJson("schemas/discovery.schema.json");
if (schema.type !== "object" || schema.additionalProperties !== false) {
  throw new Error("discovery schema must be a closed object schema");
}

const packageJson = await readJson("package.json");
for (const script of ["test", "test:unit", "test:integration", "canary", "validate", "doctor", "diff-check", "check"]) {
  if (typeof packageJson.scripts?.[script] !== "string" || !packageJson.scripts[script].trim()) {
    throw new Error(`package.json must retain the ${script} reliability script`);
  }
}

const workflow = await fs.readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
for (const requiredWorkflowToken of ["windows-latest", "ubuntu-latest", "npm run check"]) {
  if (!workflow.includes(requiredWorkflowToken)) {
    throw new Error(`CI workflow must retain ${requiredWorkflowToken}`);
  }
}

process.stdout.write("RG skill validation passed.\n");
