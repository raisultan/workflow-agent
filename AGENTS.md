# Notes for coding agents

Instructions for AI coding agents working in this repository. People: see [CONTRIBUTING](CONTRIBUTING.md), which applies to you
too.

- Run `pnpm check` (typecheck, tests, build) before you finish; it needs no network or model.
- The map is [DESIGN](docs/DESIGN.md). Respect the layering (`src/kernel/` → `src/domain/` → `src/adapters/`, checked by
  `tests/layering.spec.ts`); the domain stays pure and deterministic.
- Keep the DSH stack: Workflow Agent is built on `@deepseek-ai/dsh` and adapts `dsh-superagent-prototype` ([UPSTREAM](docs/UPSTREAM.md)).
  Do not replace the runtime or add a framework without an issue agreeing to it.
- Change docs with the code: settings in [DEPLOYMENT](docs/DEPLOYMENT.md), mechanisms in [DESIGN](docs/DESIGN.md), decisions in
  [DECISIONS](docs/DECISIONS.md), requirements in the [PRD](docs/PRD.md).
- A change to a workflow's declaration or prompts raises its `version`.
- Use synthetic data only. Never add credentials, real company data or execution data.
- Keep upstream licence notices when you bring in code, and list it in [NOTICE](NOTICE).
- Use `work/` (git-ignored) for scratch files. Do not add speculative infrastructure or features beyond the PRD and the decisions.
- Do not commit, push or publish unless the person you work for asks you to.
