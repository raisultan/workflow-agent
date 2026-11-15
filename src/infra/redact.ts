/**
 * Hiding credentials in text the workbench quotes from logs it did not write (`T10.5`): a check's command output and
 * a failed CI job's log. CI masks its own variables; this catches what a script printed itself.
 *
 * - assignments whose name looks like a credential (`NAME_TOKEN=…`, `api_key: …`, `password = "…"`);
 * - `Authorization` headers, and passwords in URLs (`https://user:pass@host`);
 * - bare tokens by their well-known shapes: GitLab (`glpat-…` and the other `gl…-` prefixes), GitHub (`ghp_`, `gho_`, `ghu_`,
 *   `ghs_`, `ghr_`, `github_pat_`), AWS access key ids (`AKIA…`, `ASIA…`), Slack (`xox?-…`), OpenAI-style keys (`sk-…`) and JWTs.
 */
const SHAPES = /\b(?:gl(?:pat|dt|rt|cbt|ptt|ft|imt|oas|soat|ffct|agent)-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{40,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abposr]-[\w-]{10,}|sk-[A-Za-z0-9_-]{20,}|eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,})\b/gu

export function redactCredentials(text: string): string {
  return text
    .replace(/\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|\S+)/giu, '$1[REDACTED]')
    .replace(/\b(authorization\s*:\s*)(?:\w+\s+)?\S+/giu, '$1[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/giu, '$1[REDACTED]@')
    .replace(SHAPES, '[REDACTED]')
}
