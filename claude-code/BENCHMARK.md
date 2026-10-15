# Claude Code Explore benchmark

Measured on 2026-10-15 with Claude Code 2.1.295 (desktop app, subscription plan, main session on Opus 5.5).

## Method

- Target: a private production web-game repository, about 7,500 tracked files, of which about 6,900 are an unrelated audit archive the scout was told to ignore.
- Four read-only mapping tasks:
  - T1: per-level shield regeneration from config through the simulation core to tests;
  - T2: admin-initiated account deletion from UI through API, coordinator, migrations, and lost-response recovery;
  - T3: a premium one-per-run power from client through server validation, core, migration, and tests;
  - T4: prerendered public leaderboard generation, background refresh, and revocation on rename/block/deletion.
- Two series, each launched from a fresh session because agent definitions are read when a session starts:
  - Built-in tiers: the built-in `Explore` agent with an explicit `model` override (Haiku, Sonnet, Opus), one run per task and tier. The prompt also asked for the compact `path:start-end — symbol — why` report.
  - RG adapter: [`agents/Explore.md`](agents/Explore.md) installed at project level and called without `model`. The task prompts were the same, minus the report-format paragraph, which the adapter defines. The first adapter prompt (v1) ran once per task; the current prompt (v2) ran twice per task.
- Token usage came from the subagent transcripts. Cost is expressed in Haiku-input-token equivalents with relative weights taken from public per-token price ratios: Haiku 1/5, Sonnet 3/15, Opus 5/25 for input/output, cache writes 1.25× (5 min) or 2× (1 h), cache reads 0.1×. Plan limits are not published per model, so this approximates how quickly a run drains them.
- The built-in transcripts keep only stream-start usage, so output is estimated from visible content (characters / 3.5) in every column, and thinking is excluded on both sides.
- Every `path:line` reference in every report was checked against `git ls-files` and file length, including comma-separated lines and `(:N)` shorthand. A sample of claims was checked against the code by hand.

## Results

| Task | RG adapter v2 (mean of 2 runs) | RG adapter v1 | Built-in Haiku 5.5 | Built-in Sonnet 5.5 | Built-in Opus 5.5 |
|---|---:|---:|---:|---:|---:|
| T1 | 120k · 79 s | 370k · 163 s | 260k · 140 s | 475k · 65 s | 858k · 86 s |
| T2 | 232k · 166 s | 580k · 288 s | 412k · 245 s | 832k · 93 s | 1,012k · 91 s |
| T3 | 115k · 87 s | 273k · 138 s | 335k · 147 s | 598k · 76 s | 805k · 68 s |
| T4 | 244k · 164 s | 444k · 205 s | 420k · 195 s | 808k · 96 s | 716k · 66 s |
| **Total weighted cost** | **0.71M (21%)** | **1.67M (49%)** | **1.43M (42%)** | **2.71M (80%)** | **3.39M (100%)** |
| Mean wall time | 2.1 min | 3.3 min | 3.0 min | 1.4 min | 1.3 min |
| Tokens processed | 2.92M | 10.06M | 7.35M | 4.10M | 2.80M |
| Model requests | 60 | 142 | 86 | 62 | 50 |
| Start-up context | 5.3k | 4.9k | 34.7k | 34.7k | 34.7k |
| `path:line` references | 163 / 185 | 198 | 162 | 209 | 133 |
| Unknown paths / out-of-range lines | 0 / 2 | 0 / 0 | 0 / 0 | 0 / 1 | 0 / 0 |

The two v2 runs totalled 0.65M and 0.78M. Short references such as `deletion.mjs:108` were resolved by a unique basename, or by line range when two files share a name. Every out-of-range reference overshoots the end of a test file by one or two lines; `10-30` in a 28-line file appeared in both a Sonnet and a v2 report. One v1 reference points to a gitignored build file that exists on disk.

## Findings

- The current adapter cut the weighted cost by 79% against built-in Explore on Opus and by 50% against built-in Explore on Haiku. Two things do it. It starts at about 5k context tokens instead of 35k, because it skips CLAUDE.md and carries three tools. Its prompt also makes it batch independent calls and stop once the report has evidence, so it made fewer model requests than built-in Haiku (60 vs 86).
- The prompt matters as much as the tier. The first adapter prompt cost 17% more than built-in Haiku because, without Bash pipelines, it made 142 requests. It also hit a Grep pitfall: the `glob` field is split on whitespace, so `!Security Audit/**` silently returned "No matches found". v2 states the rule (write the space as `?`), and its eight runs had no glob errors.
- Every series found the same owners, flows, and tests. Of the 77 files cited by both the built-in Haiku and Opus reports, the two v2 runs cited 67 and 70 (v1: 69); the misses were peripheral. No series reported a nonexistent path. In the hand-checked sample, one v2 claim was imprecise (a test that only reads a script's source was described as invoking it) and the others were correct. v2 reports often ran past the 40-line target, up to 58 lines.
- Haiku is slower per request: v2 took 2.1 minutes per task against 1.3 for Opus.
- Sonnet cut the cost by only 20%, because it processed 1.5× more tokens than Opus. It matched Opus wall time and produced the most detailed reports.
- A single exact lookup is still cheaper done directly in the main session than through any Explore call.
- Delegation keeps 30–110k tokens of raw search material out of the main context; only a 1–2.5k-token report comes back. That holds for every series.

## Limits

- The v2 prompt was written after measuring v1 on these four tasks, so its gain may be smaller on other repositories and questions.
- The built-in tiers and v1 ran once per task, so their variance is unmeasured. The two v2 runs differed by 9% around their mean in total, and by 190k vs 274k on T2.
- Thinking is excluded everywhere because the built-in transcripts do not record it. Including its thinking, v2 cost 0.96M, still below the built-in Haiku figure without thinking.
- The target repository gained one deployment-only commit between the built-in and adapter series; it did not touch the code the tasks cover.
- The tasks were well documented in the target repository's README.
