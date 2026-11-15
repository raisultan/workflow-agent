/**
 * The image and its volumes (`T11.2`): `mise` is pinned to an exact release, its archive is checked against a per-architecture
 * SHA-256 before it is unpacked, it is installed outside every `PATH`, and the toolchain volume sits outside the directories every
 * sandbox masks (`$DSH_HOME`, the state directory, the work root), so it is read-only in every sandbox rather than hidden.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')
const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8')

describe('mise in the image', () => {
  it('is an exact release, checked by SHA-256 per architecture before it is unpacked, and refused on any other architecture', () => {
    expect(dockerfile).toMatch(/ARG MISE_VERSION=\d{4}\.\d{1,2}\.\d{1,3}\n/u)
    expect(dockerfile).toMatch(/ARG MISE_SHA256_AMD64=[0-9a-f]{64}\n/u)
    expect(dockerfile).toMatch(/ARG MISE_SHA256_ARM64=[0-9a-f]{64}\n/u)
    const install = dockerfile.slice(dockerfile.indexOf('ARG MISE_VERSION'))
    expect(install.indexOf('sha256sum -c -')).toBeGreaterThan(install.indexOf('curl -fsSL --proto \'=https\''))
    expect(install.indexOf('sha256sum -c -')).toBeLessThan(install.indexOf('tar -xzf'))
    expect(install).toMatch(/\*\) echo "no mise checksum/u)
  })

  it('is outside every PATH, named to the host by WORKBENCH_MISE', () => {
    expect(dockerfile).toContain('COPY --from=build /opt/mise/bin/mise /opt/mise/bin/mise')
    expect(dockerfile).toContain('WORKBENCH_MISE=/opt/mise/bin/mise')
    expect(dockerfile).not.toMatch(/PATH=[^\n]*\/opt\/mise/u)
    expect(dockerfile).not.toMatch(/\/usr\/(?:local\/)?bin\/mise/u)
  })
})

describe('the toolchain volume', () => {
  it('is mounted for the full service at the path the image names, outside $DSH_HOME, the state directory and the work root', () => {
    const path = /WORKBENCH_TOOLCHAINS_DIR=(\S+)/u.exec(dockerfile)![1]!
    expect(compose).toContain(`- workbench-toolchains:${path}`)
    for (const masked of ['/var/lib/workbench/dsh', '/var/lib/workbench/state', '/var/lib/workbench/work']) expect(`${path}/`.startsWith(`${masked}/`)).toBe(false)
  })
})

describe('the runtime image\'s build tools (P11 review)', () => {
  it('has a C/C++ toolchain and the common headers, so a job can build a package with no wheel or prebuilt binary', () => {
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM node:'))
    const install = runtime.slice(runtime.indexOf('apt-get install'), runtime.indexOf('rm -rf /var/lib/apt/lists'))
    for (const name of ['build-essential', 'pkg-config', 'libpq-dev', 'default-libmysqlclient-dev', 'libffi-dev', 'libssl-dev', 'zlib1g-dev', 'libbz2-dev',
      'libreadline-dev', 'libsqlite3-dev', 'liblzma-dev', 'libxml2-dev', 'libxslt1-dev', 'git', 'bubblewrap']) expect([name, install.includes(` ${name}`)]).toEqual([name, true])
  })
})
