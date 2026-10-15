## Repository search (RG for Claude Code)

- For non-trivial repository search — locating files, symbols, owners, call sites, tests, dependency or cross-file flows — delegate to the Explore agent, which runs on Haiku, instead of searching in the main context. Give it the repository root, the question, the suspected area, and the evidence you need.
- Search directly only for an explicit or already-known path, a single exact lookup such as one Grep for a unique symbol, Git metadata, or a `path:line` that Explore returned. Every Explore call has a fixed start-up cost, so one-shot lookups are cheaper done directly.
- Treat the report as a map: read the cited `path:line` ranges you rely on before editing, and do not repeat broad searches it already covered. Independent questions can go to parallel Explore calls.
- If the report has an `escalate:` line, or a gap that blocks the task, run Explore once more with model `sonnet`, scoped to that gap. Escalate at most once per question; after that, do the minimum targeted search yourself and say so.
