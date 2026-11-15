# Contributing

Thank you for helping. Issues and pull requests are welcome: bugs, docs, new workflows, connectors, and reports from running it.
For anything large (a new connector, a change to how approvals or sandboxes work), open an issue first so we can agree on the
shape before you write it. Security problems go through [SECURITY](SECURITY.md), not issues.

## Setting up

You need Node.js 24 (`.nvmrc`), pnpm 11 and Docker.

```bash
pnpm install
pnpm check          # typecheck, the test suite and the build
```

`pnpm check` needs no account, network service or model: connectors are tested against fakes and local mocks, and the agent's
stages against a scripted model. Run it before every pull request; CI runs the same.

The image and full mode:

```bash
docker compose up -d --build                    # the demo, built from your checkout
docker compose --profile full up -d --build     # full mode, with your .env (docs/getting-started.md)
docker compose --profile full exec -T workbench-full node scripts/smoke-worker-isolation.ts   # the sandbox's isolation smoke
```

The evals call a real model and are manual: `pnpm eval:replies` (reading approval replies), `pnpm eval:review` (the review check)
and `pnpm eval:e2e` (whole jobs against local Mattermost, Jira and GitLab mocks; [eval/README.md](eval/README.md)).

## How the code is organised

[DESIGN](docs/DESIGN.md) is the map. In short: `src/kernel/` is the durable job kernel (inbox, engine, effects, timers);
`src/domain/` is the workflow domain (definitions, router, decider, policy), pure and deterministic; `src/adapters/` connects it to
DSH sessions, the tools and the checks; `src/sources/` holds the Jira, Mattermost and GitLab connectors; `src/client/` is the
dashboard. The layering is enforced by `tests/layering.spec.ts`.

## Conventions

- **Tests with every change**, written against behaviour, not implementation. A bug fix comes with a test that fails without it.
- **Every class has a doc comment**, and comments say why, not what (`tests/class-docs.spec.ts`).
- **Docs follow the code** in the same pull request: a setting in [DEPLOYMENT](docs/DEPLOYMENT.md), a mechanism in
  [DESIGN](docs/DESIGN.md), a decision in [DECISIONS](docs/DECISIONS.md). `tests/docs.spec.ts` checks every link.
- **A workflow change raises its version**: a changed definition under the same version is refused at startup.
- **Synthetic data only**: no real company names, tickets, people or credentials in code, tests or docs.
- **Keep the upstream notices**: code taken from another project keeps its licence and is listed in [NOTICE](NOTICE).

The codes in comments and docs name where a rule came from. `D1`–`D14` are the decisions in [DECISIONS](docs/DECISIONS.md),
`F` and `A` are the requirements and acceptance criteria in the [PRD](docs/PRD.md), and `P`, `T` and `G` are phases, tasks and
gates of the project's plan before its first public release, which is not published; read them as dates.

## Pull requests

Keep a pull request to one change, describe what it changes and why, and say how you checked it. By contributing you agree that
your contribution is licensed under the project's licence (Apache-2.0).
