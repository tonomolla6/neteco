import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { expect, it, vi } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
interface Step {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  'continue-on-error'?: boolean
}
interface Job {
  if?: string
  'runs-on': string[]
  'timeout-minutes': number
  'continue-on-error'?: boolean
  environment?: unknown
  permissions?: Record<string, string>
  env?: Record<string, string>
  steps: Step[]
}
async function configuration() {
  return parse(await readFile(resolve(root, '.github/workflows/cloudflare-compat.yml'), 'utf8')) as {
    permissions: Record<string, string>
    jobs: Record<string, Job>
  }
}
async function iacJob() {
  const workflow = await configuration()
  // Real current workflow has no such blocking gate: intentional configuration
  // RED, not a missing-module/import/syntax failure or a simulated successful CI.
  expect(workflow.jobs['iac-validate'], 'Cloudflare compatibility must block on offline IaC validation').toBeDefined()
  return workflow.jobs['iac-validate']!
}

it('requires a blocking, main-only offline IaC job on the existing Oracle ARM64 runner', async () => {
  const job = await iacJob()
  expect(job.if).toBe("github.ref == 'refs/heads/main'")
  expect(job['runs-on']).toEqual([
    'self-hosted',
    'Linux',
    'ARM64',
    "${{ vars.NETECO_ORACLE_RUNNER_LABEL || 'neteco-oracle-unverified-do-not-register' }}"
  ])
  expect(job['continue-on-error']).toBeUndefined()
  expect(job['timeout-minutes']).toBeGreaterThan(0)
  expect(job['timeout-minutes']).toBeLessThanOrEqual(10)
  expect(job.environment).toBeUndefined()
  expect((await configuration()).permissions).toEqual({ contents: 'read' })
  for (const value of Object.values(job.permissions ?? {})) expect(['read', 'none']).toContain(value)
  for (const step of job.steps) expect(step['continue-on-error']).toBeUndefined()
})

it('uses the existing approved repository guard before executing checkout or IaC code', async () => {
  const workflow = await configuration()
  const job = await iacJob()
  const reference = workflow.jobs['worker-canary']!.steps[0]!
  expect(job.steps[0]).toEqual(reference)
  expect(job.steps[1]?.uses).toBe('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1')
})

it('runs the host storage admission before the offline gate, without installers or remote operations', async () => {
  const job = await iacJob()
  const commands = job.steps.flatMap((step) =>
    step.run && step.name !== 'Verify approved Neteco repository' ? [step.run] : []
  )
  expect(commands).toEqual(['node scripts/storage-preflight.ts', 'node scripts/cloudflare-iac-check.mjs'])
  for (const step of job.steps) {
    if (step.uses) expect(step.uses).toMatch(/^actions\/(?:checkout|setup-node)@[0-9a-f]{40}$/)
    expect(step.run ?? '').not.toMatch(
      /\b(?:curl|wget|sudo|docker|terraform|tofu)\b|\b(?:apply|plan|import|destroy)\b|--remote\b|\b(?:npm ci|apt|brew)\b/
    )
  }
})

it('does not pass Cloudflare, backend, state or deployment credentials to the IaC job', async () => {
  const job = await iacJob()
  for (const env of [job.env, ...job.steps.map((step) => step.env)]) {
    for (const [name, value] of Object.entries(env ?? {})) {
      expect(name).not.toMatch(/CLOUDFLARE|CF_API|TOKEN|SECRET|TF_HTTP|TF_CLI|AWS_|GOOGLE_|AZURE_|DEPLOY/)
      expect(value).not.toMatch(/secrets\./)
    }
  }
  expect(JSON.stringify(job)).not.toContain('upload-artifact')
  expect(JSON.stringify(job)).not.toContain('environment-file')
})

it('preserves the existing complete storefront, canary and five real D1 checks', async () => {
  const workflow = await configuration()
  await iacJob()
  expect(workflow.jobs['shop-runtime']!.steps.some((step) => step.run === 'npm run audit:shop:ci')).toBe(true)
  expect(workflow.jobs['worker-canary']!.steps.some((step) => step.run === 'npm run test:worker')).toBe(true)
  expect(
    workflow.jobs['d1-audits']!.steps.some((step) => step.run === 'npx tsx scripts/audit-d1-${{ matrix.audit }}.ts')
  ).toBe(true)
})

async function gateModule() {
  return import(new URL('../../scripts/cloudflare-iac-check.mjs', import.meta.url).href)
}

function boundary(failure?: string) {
  const events: string[] = []
  const context = {
    temporary: '/owned-test-directory',
    env: { PATH: '/usr/bin:/bin' },
    unchanged: vi.fn(async () => {
      events.push('unchanged')
    })
  }
  const dependencies = {
    admission: vi.fn(async () => {
      events.push('admission')
    }),
    verify: vi.fn(async () => {
      events.push('verify')
      if (failure === 'missingtoolchain' || failure === 'hash') throw new Error(failure)
    }),
    prepare: vi.fn(async () => {
      events.push('prepare')
      return context
    }),
    command: vi.fn(async (_context: typeof context, args: string[]) => {
      const stage = args[0]!
      events.push(stage)
      if (stage === failure || failure === 'networkdenied') throw new Error('execution refused')
      if (stage === 'version')
        return { stdout: JSON.stringify({ terraform_version: failure === 'wrongversion' ? '1.10.5' : '1.10.6' }) }
      if (stage === 'validate')
        return {
          stdout: JSON.stringify({
            valid: failure !== 'invalid',
            error_count: failure === 'invalid' ? 1 : 0,
            warning_count: 0
          })
        }
      return { stdout: '' }
    }),
    cleanup: vi.fn(async (path: string) => {
      expect(path).toBe(context.temporary)
      await Promise.resolve()
      events.push('cleaned')
    })
  }
  return { dependencies, events, context }
}

it.each(['missingtoolchain', 'hash'])('rejects %s before staging IaC or executing a tool', async (failure) => {
  const { runOfflineIacCheck } = await gateModule()
  const fixture = boundary(failure)
  await expect(runOfflineIacCheck(fixture.dependencies)).rejects.toThrow(failure)
  expect(fixture.events).toEqual(['admission', 'verify'])
  expect(fixture.dependencies.command).not.toHaveBeenCalled()
  expect(fixture.dependencies.cleanup).not.toHaveBeenCalled()
})

it.each(['wrongversion', 'fmt', 'init', 'validate', 'invalid', 'networkdenied'])(
  'fails closed at %s and awaits cleanup before rejecting',
  async (failure) => {
    const { runOfflineIacCheck } = await gateModule()
    const fixture = boundary(failure)
    await expect(runOfflineIacCheck(fixture.dependencies)).rejects.toThrow()
    expect(fixture.events.at(-1)).toBe('cleaned')
    expect(fixture.dependencies.cleanup).toHaveBeenCalledTimes(1)
    expect(fixture.context.unchanged).not.toHaveBeenCalled()
    if (failure === 'fmt') expect(fixture.events).not.toContain('init')
    if (failure === 'init') expect(fixture.events).not.toContain('validate')
    if (failure === 'networkdenied') expect(fixture.events).not.toContain('fmt')
  }
)

it('executes fmt, backend-disabled init and validation in order, then verifies source and awaits cleanup', async () => {
  const { runOfflineIacCheck } = await gateModule()
  const fixture = boundary()
  await expect(runOfflineIacCheck(fixture.dependencies)).resolves.toMatchObject({ status: 'passed', offline: true })
  expect(fixture.events).toEqual([
    'admission',
    'verify',
    'prepare',
    'version',
    'fmt',
    'init',
    'validate',
    'unchanged',
    'cleaned'
  ])
  const init = fixture.dependencies.command.mock.calls.find((call) => call[1][0] === 'init')![1]
  expect(init).toEqual([
    'init',
    '-backend=false',
    '-get=false',
    '-input=false',
    '-no-color',
    '-plugin-dir=/usr/local/libexec/neteco-ci/iac/mirror'
  ])
  expect(fixture.dependencies.command.mock.calls.flatMap((call) => call[1])).not.toEqual(
    expect.arrayContaining(['plan', 'apply'])
  )
})

it('verifies pinned archive provenance and extracted binary hashes rather than trusting manifest labels', async () => {
  const { verifyToolchainManifest, PINNED_ARCHIVES } = await gateModule()
  const binaries = { tofu: Buffer.from('fixture tofu'), cloudflare: Buffer.from('fixture provider') }
  const manifest = {
    schemaVersion: 1,
    tofuVersion: '1.10.6',
    providerVersion: '5.25.0',
    platform: 'linux_arm64',
    tofu: {
      archiveSha256: PINNED_ARCHIVES.tofu,
      binarySha256: createHash('sha256').update(binaries.tofu).digest('hex')
    },
    cloudflare: {
      archiveSha256: PINNED_ARCHIVES.cloudflare,
      binarySha256: createHash('sha256').update(binaries.cloudflare).digest('hex')
    }
  }
  expect(() => verifyToolchainManifest(manifest, binaries)).not.toThrow()
  expect(() => verifyToolchainManifest({ ...manifest, tofuVersion: '1.10.5' }, binaries)).toThrow('toolchain_version')
  expect(() =>
    verifyToolchainManifest({ ...manifest, tofu: { ...manifest.tofu, archiveSha256: '0'.repeat(64) } }, binaries)
  ).toThrow('toolchain_hash')
  expect(() => verifyToolchainManifest(manifest, { ...binaries, cloudflare: Buffer.from('changed') })).toThrow(
    'toolchain_hash'
  )
})

it('does not report success when asynchronous cleanup fails', async () => {
  const { runOfflineIacCheck } = await gateModule()
  const fixture = boundary()
  fixture.dependencies.cleanup.mockImplementation(async () => {
    await Promise.resolve()
    throw new Error('cleanup_failed')
  })
  await expect(runOfflineIacCheck(fixture.dependencies)).rejects.toThrow('cleanup_failed')
})

it('rejects swap in the job cgroup but tolerates swap held by other services in shared ancestors', async () => {
  const { assertCgroupMemoryBudget } = await import('../../scripts/cloudflare-iac-check.mjs')
  const tree = (leafSwap: number) =>
    new Map([
      ['/sys/fs/cgroup/system.slice/runner.service/memory.current', '1000'],
      ['/sys/fs/cgroup/system.slice/runner.service/memory.max', String(8 * 1024 ** 3)],
      ['/sys/fs/cgroup/system.slice/runner.service/memory.swap.current', String(leafSwap)],
      ['/sys/fs/cgroup/system.slice/memory.current', String(4 * 1024 ** 3)],
      ['/sys/fs/cgroup/system.slice/memory.max', 'max'],
      ['/sys/fs/cgroup/system.slice/memory.swap.current', String(2 * 1024 ** 3)]
    ])
  const reader = (files: Map<string, string>) => async (path: string) => {
    const value = files.get(path)
    if (value === undefined) throw new Error(`unexpected read ${path}`)
    return value
  }
  await expect(assertCgroupMemoryBudget('/system.slice/runner.service', reader(tree(0)))).resolves.toBeUndefined()
  await expect(assertCgroupMemoryBudget('/system.slice/runner.service', reader(tree(4096)))).rejects.toThrow(
    'cgroup_swap_in_use'
  )
})
