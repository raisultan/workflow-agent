# Hidden acceptance tests

The eval's acceptance tests, one directory per scenario (`eval/scenarios.ts`). They are never in a repository the mock GitLab
serves, so no agent can read them. After a job ends, `eval/e2e.ts` copies them into a clone of its merge request's branch and
runs them there: Node tests at `tests/hidden/`, Python tests at `tests/` (so the repository's `conftest.py` and its services apply).
`node eval/e2e.ts --check-hidden` checks that each fails on its base commit.
