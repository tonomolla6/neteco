import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const scripts = (
  JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>
  }
).scripts
interface Step {
  run?: string
  shell?: string
  env?: Record<string, string>
  uses?: string
  id?: string
  if?: string
  'continue-on-error'?: boolean
  with?: Record<string, unknown>
}
const workflow = parse(
  await readFile(new URL('../../.github/workflows/cloudflare-compat.yml', import.meta.url), 'utf8')
) as {
  permissions: Record<string, string>
  jobs: Record<string, { if?: string; 'runs-on': string[]; steps: Step[] }>
}
const stages = [
  'build:cloudflare-ui',
  'build:worker-shop',
  'audit:shop-bundle',
  'artifacts:cloudflare:emit',
  'artifacts:cloudflare:verify'
]

it('builds once and stops the real shell composition at every failed artifact gate', async () => {
  const composition = scripts['build:shop:cloudflare']
  expect(composition).toBeTypeOf('string')
  // Only the declared npm run stages may be executed by this isolated test.
  // A fake npm records calls; no actual build, install, network or upload runs.
  expect(composition.split(/\s*&&\s*/)).toEqual(stages.map((stage) => `npm run ${stage}`))
  const directory = await mkdtemp(join(tmpdir(), 'neteco-artifact-ci-'))
  try {
    await writeFile(
      join(directory, 'npm'),
      `#!${process.execPath}\nimport{appendFileSync}from'node:fs';const stage=process.argv[3];appendFileSync(process.env.ARTIFACT_CALLS,stage+'\\n');process.exit(stage===process.env.ARTIFACT_FAIL?17:0)\n`,
      { mode: 0o700 }
    )
    for (const failed of [...stages, '']) {
      const calls = join(directory, 'calls')
      await writeFile(calls, '')
      let exit = 0
      try {
        await execute('/bin/bash', ['-c', composition], {
          cwd: directory,
          timeout: 5000,
          maxBuffer: 4096,
          env: { ...process.env, PATH: directory, ARTIFACT_CALLS: calls, ARTIFACT_FAIL: failed }
        })
      } catch (error) {
        exit = Number((error as { code: number }).code)
      }
      expect(exit).toBe(failed ? 17 : 0)
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(
        stages.slice(0, failed ? stages.indexOf(failed) + 1 : stages.length)
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('uses the same stable manifest and SBOM for offline emission and verification', () => {
  const emit = scripts['artifacts:cloudflare:emit']
  const verify = scripts['artifacts:cloudflare:verify']
  expect(emit?.split(/\s+/)).toEqual([
    'tsx',
    'scripts/emit-cloudflare-artifacts.ts',
    '--root=.',
    '--output=.wrangler/shop-evidence'
  ])
  expect(verify?.split(/\s+/)).toEqual([
    'tsx',
    'scripts/emit-cloudflare-artifacts.ts',
    '--root=.',
    '--manifest=.wrangler/shop-evidence/manifest.json',
    '--sbom-input=.wrangler/shop-evidence/sbom.cdx.json'
  ])
})

it('runs the compiled contracts after one build and blocks subsequent local gates on any failure', async () => {
  const composition = scripts['cloudflare:shop:check']
  const expected = ['build:shop:cloudflare', 'test:compiled', 'audit:shop:local', 'artifacts:cloudflare:verify']
  expect(composition).toBeTypeOf('string')
  // Execute the actual package script, but permit only npm run invocations in
  // this isolated harness. No real toolchain/build/browser command is invoked.
  expect(composition.split(/\s*&&\s*/).every((command) => /^npm run [a-z:-]+$/.test(command))).toBe(true)
  const directory = await mkdtemp(join(tmpdir(), 'neteco-local-shop-ci-'))
  try {
    await writeFile(
      join(directory, 'npm'),
      `#!${process.execPath}\nimport{appendFileSync}from'node:fs';const stage=process.argv[3];appendFileSync(process.env.ARTIFACT_CALLS,stage+'\\n');process.exit(stage===process.env.ARTIFACT_FAIL?17:0)\n`,
      { mode: 0o700 }
    )
    for (const failed of ['', ...expected]) {
      const calls = join(directory, 'calls')
      await writeFile(calls, '')
      let exit = 0
      try {
        await execute('/bin/bash', ['-c', composition], {
          cwd: directory,
          timeout: 5000,
          maxBuffer: 4096,
          env: { ...process.env, PATH: directory, ARTIFACT_CALLS: calls, ARTIFACT_FAIL: failed }
        })
      } catch (error) {
        exit = Number((error as { code: number }).code)
      }
      expect(exit).toBe(failed ? 17 : 0)
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(
        expected.slice(0, failed ? expected.indexOf(failed) + 1 : expected.length)
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('requires compiled contracts after building and before browser auditing or publishing on Oracle', () => {
  const steps = workflow.jobs['shop-runtime']!.steps
  const build = steps.findIndex((step) => step.run === 'npm run build:shop:cloudflare')
  const compiled = steps.findIndex((step) => step.run === 'npm run test:compiled')
  const audit = steps.findIndex((step) => step.run === 'npm run audit:shop:ci')
  expect(build).toBeGreaterThan(-1)
  expect(compiled).toBeGreaterThan(build)
  expect(steps[audit]?.shell).toBe('/usr/local/libexec/neteco-ci/remote-browser-shell {0}')
  expect(steps[audit]?.env).toMatchObject({
    PW_TEST_CONNECT_WS_ENDPOINT: 'ws://127.0.0.1:8997/neteco-ci-browser',
    PW_TEST_CONNECT_EXPOSE_NETWORK: '<loopback>'
  })
  expect(steps.some((step) => /playwright install/.test(step.run ?? ''))).toBe(false)
  expect(audit).toBeGreaterThan(compiled)
  expect(steps[compiled]?.if).toBeUndefined()
  expect(steps[compiled]?.['continue-on-error']).toBeUndefined()
})

it('requires compiled UI journeys before the long browser audit and fails closed when they fail', async () => {
  const composition = scripts['audit:shop:local']
  expect(composition).toBe('npm run test:compiled:browser && tsx scripts/audit-cloudflare-shop.ts')
  const directory = await mkdtemp(join(tmpdir(), 'neteco-browser-gate-'))
  try {
    const fake = `#!${process.execPath}\nimport{appendFileSync}from'node:fs';const stage=process.argv[1].endsWith('/npm')?process.argv[3]:'full-audit';appendFileSync(process.env.ARTIFACT_CALLS,stage+'\\n');process.exit(stage===process.env.ARTIFACT_FAIL?17:0)\n`
    await writeFile(join(directory, 'npm'), fake, { mode: 0o700 })
    await writeFile(join(directory, 'tsx'), fake, { mode: 0o700 })
    for (const failed of ['', 'test:compiled:browser', 'full-audit']) {
      const calls = join(directory, 'calls')
      await writeFile(calls, '')
      let exit = 0
      try {
        await execute('/bin/bash', ['-c', composition], {
          cwd: directory,
          timeout: 5000,
          maxBuffer: 4096,
          env: { ...process.env, PATH: directory, ARTIFACT_CALLS: calls, ARTIFACT_FAIL: failed }
        })
      } catch (error) {
        exit = Number((error as { code: number }).code)
      }
      expect(exit).toBe(failed ? 17 : 0)
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(
        failed === 'test:compiled:browser' ? ['test:compiled:browser'] : ['test:compiled:browser', 'full-audit']
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('sets enforced browser mode in the actual compiled browser shell command', async () => {
  const command = scripts['test:compiled:browser']
  expect(command).toBeTypeOf('string')
  expect(command).toMatch(/^NETECO_COMPILED_BROWSER_REQUIRED=true vitest run --config vitest\.compiled\.config\.ts$/)
  const directory = await mkdtemp(join(tmpdir(), 'neteco-browser-mode-'))
  try {
    await writeFile(
      join(directory, 'vitest'),
      `#!${process.execPath}\nprocess.stdout.write(String(process.env.NETECO_COMPILED_BROWSER_REQUIRED));process.exit(process.env.NETECO_COMPILED_BROWSER_REQUIRED==='true'?0:19)\n`,
      { mode: 0o700 }
    )
    const result = await execute('/bin/bash', ['-c', command!], {
      cwd: directory,
      timeout: 5000,
      maxBuffer: 4096,
      env: { ...process.env, PATH: directory }
    })
    expect(result.stdout).toBe('true')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('verifies the exact build before and after the required shop audit and publishes only verified evidence', () => {
  const steps = workflow.jobs['shop-runtime']!.steps
  const build = steps.findIndex((step) => step.run === 'npm run build:shop:cloudflare')
  const audit = steps.findIndex((step) => step.run === 'npm run audit:shop:ci')
  const verified = steps.findIndex(
    (step) => step.run === 'npm run artifacts:cloudflare:verify' && step.id === 'verified-cloudflare-artifacts'
  )
  const upload = steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact@'))
  expect(build).toBeGreaterThan(-1)
  expect(audit).toBeGreaterThan(build)
  expect(verified).toBeGreaterThan(audit)
  expect(upload).toBeGreaterThan(verified)
  expect(steps.slice(build + 1).filter((step) => /npm run build:/.test(step.run ?? ''))).toEqual([])
  expect(
    steps.slice(build, upload + 1).every((step) => !step['continue-on-error'] && !step.if?.includes('always()'))
  ).toBe(true)
  const publication = steps[upload]!
  expect(publication.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a')
  expect(publication.if).toBe(
    "success() && steps.verified-cloudflare-artifacts.outcome == 'success' && steps.assessed-cloudflare-vulnerabilities.outcome == 'success'"
  )
  expect(publication.with).toMatchObject({
    'retention-days': 14,
    'if-no-files-found': 'error',
    'include-hidden-files': true
  })
  expect(String(publication.with?.path).trim().split(/\s+/)).toEqual([
    '.wrangler/shop-evidence/manifest.json',
    '.wrangler/shop-evidence/sbom.cdx.json',
    '.wrangler/shop-evidence/vulnerabilities.json'
  ])
})

it('preserves Oracle ARM64 quarantine and read-only workflow permissions without adding deployment', () => {
  const job = workflow.jobs['shop-runtime']!
  expect(job['runs-on']).toEqual([
    'self-hosted',
    'Linux',
    'ARM64',
    "${{ vars.NETECO_ORACLE_RUNNER_LABEL || 'neteco-oracle-unverified-do-not-register' }}"
  ])
  expect(job.if).toBe("github.ref == 'refs/heads/main'")
  expect(workflow.permissions).toEqual({ contents: 'read' })
  const runs = job.steps.map((step) => step.run ?? '').join('\n')
  expect(runs).toContain('node scripts/storage-preflight.ts')
  expect(runs).toContain('test "$GITHUB_REPOSITORY" = "$NETECO_GITHUB_REPOSITORY"')
  expect(runs).not.toMatch(/wrangler\s+(?:deploy|publish)|npm\s+(?:publish|audit)/)
})
