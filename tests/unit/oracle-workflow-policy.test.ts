import { readdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const directory = resolve(process.cwd(), '.github/workflows')
const files = (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file))

interface Workflow {
  on: Record<string, unknown>
  env?: Record<string, string>
  permissions: Record<string, string>
  jobs: Record<
    string,
    {
      if?: string
      'runs-on': unknown
      'continue-on-error'?: boolean
      steps: Array<{
        run?: string
        name?: string
        uses?: string
        id?: string
        if?: string
        env?: Record<string, string>
        with?: Record<string, unknown>
        'continue-on-error'?: boolean
      }>
    }
  >
}

describe('Oracle-only workflow scheduling policy', () => {
  it.each(files)('%s fails (not skips) jobs for missing, mismatched or reference repository targets', async (file) => {
    const workflow = parse(await readFile(resolve(directory, file), 'utf8')) as Workflow
    expect(workflow.env?.NETECO_GITHUB_REPOSITORY).toBe('${{ vars.NETECO_GITHUB_REPOSITORY }}')
    const testedScripts = new Set<string>()
    for (const job of Object.values(workflow.jobs)) {
      const index = job.steps.findIndex((step) => step.name === 'Verify approved Neteco repository')
      expect(index).toBeGreaterThanOrEqual(0)
      const guard = job.steps[index]!
      expect(guard.if).toBeUndefined()
      expect(guard['continue-on-error']).not.toBe(true)
      expect(guard.run).not.toContain('${{')
      expect(job.if).toBe("github.ref == 'refs/heads/main'")
      expect(job.steps.slice(0, index).some((step) => step.run)).toBe(false)
      if (!guard.run) throw new Error('Repository guard must execute, not skip.')
      // Validate every job above; execute identical guard bodies only once per
      // workflow, rather than repeatedly spawning the same six Bash cases.
      if (testedScripts.has(guard.run)) continue
      testedScripts.add(guard.run)
      const cases = [
        ['example-owned/neteco', undefined, false],
        ['example-owned/neteco', '', false],
        ['example-owned/neteco', 'different-owned/neteco', false],
        ['PublicHer0/neteco-shop', 'PublicHer0/neteco-shop', false],
        ['PUBLICHER0/NETECO-SHOP', 'PUBLICHER0/NETECO-SHOP', false],
        ['example-owned/neteco', 'example-owned/neteco', true]
      ] as const
      // One Bash startup; each standalone subshell has isolated environment and
      // errexit. Do not put it in an `if`, which suppresses Bash's errexit.
      const program = cases
        .map(([repository, target]) =>
          [
            '(',
            'set -e',
            `export GITHUB_REPOSITORY=${JSON.stringify(repository)}`,
            target === undefined
              ? 'unset NETECO_GITHUB_REPOSITORY'
              : `export NETECO_GITHUB_REPOSITORY=${JSON.stringify(target)}`,
            guard.run,
            ')',
            'printf "%s\\n" "$?"'
          ].join('\n')
        )
        .join('\n')
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `set +e\n${program}`], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 1000
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout.trim().split('\n').map(Number)).toEqual(cases.map(([, , allowed]) => (allowed ? 0 : 1)))
    }
  })
  it('validates the UAT commit against trusted main before checking out or executing target code', async () => {
    const workflow = parse(await readFile(resolve(directory, 'staging-uat.yml'), 'utf8')) as Workflow
    const steps = workflow.jobs.gate!.steps
    expect(steps.find((step) => step.uses?.startsWith('actions/checkout@'))!.with).toMatchObject({
      ref: '${{ github.sha }}',
      'fetch-depth': 0
    })
    const validation = steps.findIndex((step) => step.id === 'validate-commit')
    const target = steps.findIndex((step) => step.with?.ref === '${{ inputs.expected_commit }}')
    expect(validation).toBeGreaterThan(0)
    expect(target).toBeGreaterThan(validation)
    expect(steps[validation]!.run).toContain('^[0-9a-fA-F]{40}$')
    expect(steps[validation]!.run).toContain('git cat-file -e "$UAT_EXPECTED_COMMIT^{commit}"')
    expect(steps[validation]!.run).toContain('git merge-base --is-ancestor "$UAT_EXPECTED_COMMIT" "$GITHUB_SHA"')
    expect(steps[validation]!.run).not.toContain('${{')
    expect(
      steps
        .slice(0, target)
        .filter((step) => step.run && step.name !== 'Verify approved Neteco repository')
        .map((step) => step.id)
    ).toEqual(['validate-commit'])
    expect(
      steps
        .slice(target + 1)
        .some((step) => step.with?.ref === '${{ github.sha }}' && step.with?.path === 'uat-evidence-source')
    ).toBe(true)
  })
  it('isolates container artifacts in an owned runner temporary directory and cleans it even on failure', async () => {
    const workflow = parse(await readFile(resolve(directory, 'ci.yml'), 'utf8')) as Workflow
    const steps = workflow.jobs.container!.steps
    const temporary = steps.find((step) => step.id === 'container-artifacts')
    expect(temporary?.run).toContain('mktemp -d "$RUNNER_TEMP/neteco-container.XXXXXXXX"')
    expect(temporary?.run).toContain('"$GITHUB_OUTPUT"')
    const exportStep = steps.find((step) => step.run?.includes('docker save'))
    expect(exportStep?.if).not.toBe('always()')
    expect(exportStep?.env?.ARTIFACT_DIR).toBe('${{ steps.container-artifacts.outputs.directory }}')
    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
    expect(upload?.with?.path).toBe('${{ steps.container-artifacts.outputs.directory }}/*')
    expect(upload?.if).toContain("steps.container-artifacts.outcome == 'success'")
    const cleanup = steps.at(-1)!
    expect(cleanup.id).toBe('cleanup-container-artifacts')
    expect(cleanup.if).toContain('always()')
    expect(cleanup.run).toContain('realpath -e -- "$ARTIFACT_DIR"')
    expect(cleanup.run).toContain('^neteco-container\\.[a-zA-Z0-9]{8}$')
    expect(cleanup.run).toContain('"$(dirname -- "$artifact_dir")" == "$temporary_root"')
    expect(cleanup.run).toContain('"$artifact_dir" == "$ARTIFACT_DIR"')
    expect(cleanup.run).toContain('rm -rf -- "$artifact_dir"')
    expect(JSON.stringify(steps)).not.toMatch(/\/tmp\/neteco-(?:image|container-sbom|trivy)/)
    expect(steps.some((step) => step.uses?.startsWith('anchore/sbom-action@'))).toBe(true)
    expect(steps.some((step) => step.uses?.startsWith('aquasecurity/trivy-action@'))).toBe(true)
  })
  it('names and cleans the buildx builder for only the current run even after failure or cancellation', async () => {
    const workflow = parse(await readFile(resolve(directory, 'ci.yml'), 'utf8')) as Workflow
    const steps = workflow.jobs.container!.steps
    const allocation = steps.find((step) => step.id === 'container-artifacts')!
    const setup = steps.find((step) => step.uses?.startsWith('docker/setup-buildx-action@'))!
    const cleanup = steps.find((step) => step.id === 'cleanup-buildx')!
    expect(allocation.run).toContain('builder=')
    expect(setup.id).toBe('buildx')
    expect(setup.with?.name).toBe('${{ steps.container-artifacts.outputs.builder }}')
    expect(cleanup.if).toContain('always()')
    expect(cleanup.if).toContain("steps.container-artifacts.outcome == 'success'")
    expect(cleanup.if).toContain("steps.buildx.outcome != 'skipped'")
    expect(cleanup.env?.BUILDER_NAME).toBe('${{ steps.container-artifacts.outputs.builder }}')
    expect(cleanup.env?.ARTIFACT_DIR).toBe('${{ steps.container-artifacts.outputs.directory }}')
    expect(cleanup.run).toBe('bash scripts/cleanup-ci-builder.sh')
    expect(steps.indexOf(cleanup)).toBeLessThan(steps.findIndex((step) => step.id === 'cleanup-container-artifacts'))
    expect(cleanup['continue-on-error']).toBeUndefined()
  })
  it('reuses ARM64 build layers across isolated builders and still loads the image for mandatory scans', async () => {
    const workflow = parse(await readFile(resolve(directory, 'ci.yml'), 'utf8')) as Workflow
    const build = workflow.jobs.container!.steps.find((step) => step.uses?.startsWith('docker/build-push-action@'))!
    expect(build.with?.['cache-from']).toBe('type=gha,scope=neteco-linux-arm64')
    expect(build.with?.['cache-to']).toBe('type=gha,scope=neteco-linux-arm64,mode=max')
    expect(build.with?.load).toBe(true)
    expect(build.with?.push).toBe(false)
    const steps = workflow.jobs.container!.steps
    const budget = steps.findIndex(
      (step) => step.run === 'node /usr/local/libexec/neteco-ci/build-storage.mjs --estimated-output-gib 3'
    )
    expect(budget).toBeGreaterThanOrEqual(0)
    expect(budget).toBeLessThan(steps.findIndex((step) => step.uses?.startsWith('docker/setup-buildx-action@')))
  })
  it.each(files)('%s cannot schedule hosted compute or untrusted pull request code', async (file) => {
    const workflow = parse(await readFile(resolve(directory, file), 'utf8')) as Workflow
    expect(workflow.on).toBeTypeOf('object')
    expect(workflow.on).not.toHaveProperty('pull_request')
    expect(workflow.on).not.toHaveProperty('pull_request_target')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0)
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.if).toBe("github.ref == 'refs/heads/main'")
      expect(job.steps.some((step) => step.run === 'node scripts/storage-preflight.ts')).toBe(true)
      // No destination repository has been identified. The denial label must never
      // be assigned; an operator configures a real label only after verification.
      expect(job['runs-on'], `${file}/${name}`).toEqual([
        'self-hosted',
        'Linux',
        'ARM64',
        "${{ vars.NETECO_ORACLE_RUNNER_LABEL || 'neteco-oracle-unverified-do-not-register' }}"
      ])
      expect(job['continue-on-error']).not.toBe(true)
      expect(job.steps.length).toBeGreaterThan(0)
      for (const step of job.steps) {
        expect(step['continue-on-error']).not.toBe(true)
        expect(step.run ?? '').not.toMatch(/\bsudo\b|playwright install --with-deps/)
      }
    }
  })
})
