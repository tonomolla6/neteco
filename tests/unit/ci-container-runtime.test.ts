import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
const job = workflow.jobs.container

it('compiles on the admitted Oracle runner before packaging the immutable output', () => {
  const commands = job.steps.map((step: { run?: string }) => step.run ?? '')
  const admission = commands.indexOf('node scripts/ci-build-memory-preflight.mjs')
  const install = commands.indexOf('npm ci')
  const build = commands.findIndex((command: string) => command.includes('npm run build'))
  const packageIndex = job.steps.findIndex((step: { uses?: string }) =>
    step.uses?.startsWith('docker/build-push-action@')
  )
  expect(admission).toBeGreaterThanOrEqual(0)
  expect(install).toBeGreaterThan(admission)
  expect(build).toBeGreaterThan(install)
  expect(packageIndex).toBeGreaterThan(build)
  expect(commands[build]).toContain('--max-old-space-size=4096')
  expect(commands[build]).toContain('scripts/limit-build-workers.cjs')
  expect(job.steps[packageIndex].with).toMatchObject({
    file: 'Dockerfile.ci',
    'build-contexts': 'neteco-output=.output',
    load: true,
    push: false
  })
})

it('keeps image scanning, provenance and job-owned cleanup blocking', () => {
  expect(job['runs-on']).toContain('ARM64')
  expect(job['timeout-minutes']).toBe(45)
  expect(job['continue-on-error']).toBeUndefined()
  const scanner = job.steps.find((step: { uses?: string }) => step.uses?.startsWith('aquasecurity/trivy-action@'))
  expect(scanner.with).toMatchObject({ 'exit-code': '1', severity: 'CRITICAL,HIGH' })
  expect(job.steps.some((step: { uses?: string }) => step.uses?.startsWith('anchore/sbom-action@'))).toBe(true)
  expect(job.steps.find((step: { id?: string }) => step.id === 'cleanup-buildx').if).toContain('always()')
  for (const step of job.steps) expect(step['continue-on-error']).toBeUndefined()
})

it('packages only output in an ABI-compatible non-root image without compilers', () => {
  const dockerfile = readFileSync('Dockerfile.ci', 'utf8')
  expect(dockerfile).toContain('node:24.18.1-bookworm-slim')
  expect(dockerfile).toContain('COPY --from=neteco-output --chown=10001:10001 / ./.output')
  expect(dockerfile).toContain('USER 10001:10001')
  expect(dockerfile).toContain('ARG APP_VERSION')
  expect(dockerfile).toContain('APP_VERSION=${APP_VERSION}')
  expect(dockerfile).toContain('CMD ["node", ".output/server/index.mjs"]')
  expect(dockerfile).not.toMatch(/npm (?:ci|install|run)|COPY \.|NODE_OPTIONS|FROM .*AS build/)
})
