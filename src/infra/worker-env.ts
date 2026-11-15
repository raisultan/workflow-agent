/**
 * The environment variables a worker never gets: credential-shaped names, the operator's SSH and git settings, and the
 * variables that tell git which repository to act on. A module of plain constants with no imports, so the sandbox wrapper
 * (`src/sandbox/`) shares them with the host.
 */
/**
 * Widened forbidden environment variable pattern for worker subprocesses.
 * Matches credential-shaped names (`KEY`, `PASSWORD`, `SECRET`, `TOKEN`, `AUTH`, `CREDENTIAL`, `COOKIE`),
 * infrastructure endpoints (`DATABASE_URL`, `DOCKER_HOST`), and connector/model prefixes (`JIRA_*`, `MATTERMOST_*`, `GITLAB_*`, `LITELLM_*`).
 */
export const WORKER_FORBIDDEN_ENV_PATTERN =
  /KEY|PASSWORD|SECRET|TOKEN|AUTH|CREDENTIAL|COOKIE|DATABASE_URL|DOCKER_HOST|^(?:JIRA|MATTERMOST|GITLAB|LITELLM)_/iu

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/** Operator SSH and git environment variables always stripped from worker subprocesses. */
export const STRIPPED_WORKER_ENV_KEYS: readonly string[] = [
  'SSH_AUTH_SOCK',
  'SSH_ASKPASS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_AUTHOR_NAME',
  'GIT_COMMITTER_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_EMAIL',
  ...GIT_LOCATION,
]
