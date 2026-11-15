import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsdown'

/** The dashboard's fonts (`D13`): the latin and cyrillic subsets of Onest and JetBrains Mono, with their licences (SIL OFL 1.1). */
const FONTS = [
  ['@fontsource-variable/onest', ['onest-latin-wght-normal.woff2', 'onest-cyrillic-wght-normal.woff2'], 'onest-LICENSE.txt'],
  ['@fontsource-variable/jetbrains-mono', ['jetbrains-mono-latin-wght-normal.woff2', 'jetbrains-mono-cyrillic-wght-normal.woff2'], 'jetbrains-mono-LICENSE.txt'],
] as const

/** Copies the page, its stylesheet and icon, and the fonts next to the dashboard's bundle. */
function copyDashboardFiles(): void {
  const out = 'lib/dashboard'
  mkdirSync(join(out, 'fonts'), { recursive: true })
  for (const name of ['index.html', 'app.css', 'favicon.svg']) copyFileSync(join('src/client', name), join(out, name))
  for (const [pkg, files, licence] of FONTS) {
    for (const file of files) copyFileSync(join('node_modules', pkg, 'files', file), join(out, 'fonts', file))
    copyFileSync(join('node_modules', pkg, 'LICENSE'), join(out, 'fonts', licence))
  }
}

export default defineConfig([
  { entry: { index: 'src/index.ts', 'jira-watch': 'src/sources/jira.ts', 'mattermost-watch': 'src/sources/mattermost.ts', 'gitlab-watch': 'src/sources/gitlab.ts', 'sandbox-wrapper': 'src/sandbox/wrapper.ts', 'sandbox-bridge': 'src/sandbox/bridge.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: true, clean: true, deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] } },
  // The dashboard's page (`D13`): one ES module with React inside, served by the runtime's own server from `lib/dashboard`.
  { entry: { app: 'src/client/main.tsx' }, outDir: 'lib/dashboard', format: 'esm', fixedExtension: false, platform: 'browser', target: 'es2022', dts: false, clean: false,
    minify: true, define: { 'process.env.NODE_ENV': '"production"' }, deps: { alwaysBundle: [/^react/, /^scheduler/] }, onSuccess: copyDashboardFiles },
])
