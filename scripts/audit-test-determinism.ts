import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

interface Violation {
  file: string
  rule: string
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? sourceFiles(path) : Promise.resolve(path.endsWith('.ts') ? [path] : [])
    })
  )
  return nested.flat().sort()
}

const rules = [
  { name: 'native random UUID', pattern: /\bcrypto\.randomUUID\s*\(/ },
  { name: 'imported random UUID', pattern: /import\s*\{[^}]*\brandomUUID\b[^}]*\}\s*from\s*['"]node:crypto['"]/s },
  { name: 'pseudo-random number', pattern: /\bMath\.random\s*\(/ },
  { name: 'wall-clock timestamp', pattern: /\bDate\.now\s*\(/ },
  { name: 'implicit wall-clock date', pattern: /new\s+Date\s*\(\s*\)/ },
  { name: 'HTTP Date header used as clock', pattern: /headers\(\)\.date|headers\(\)\[['"]date['"]\]/ },
  { name: 'raw Node network client', pattern: /from\s*['"]node:(?:http|https|net|tls)['"]/ }
]

const root = resolve('tests')
const files = await sourceFiles(root)
const violations: Violation[] = []
for (const file of files) {
  const source = await readFile(file, 'utf8')
  for (const rule of rules) {
    const controlledLocalNetwork =
      rule.name === 'raw Node network client' &&
      relative(process.cwd(), file) === 'tests/integration/provider-recovery.test.ts' &&
      source.includes('determinism-audit: allow-local-network-harness')
    if (rule.pattern.test(source) && !controlledLocalNetwork) {
      violations.push({ file: relative(process.cwd(), file), rule: rule.name })
    }
  }
  if (file.includes('/tests/e2e/') && file.endsWith('.spec.ts') && !source.includes("from '../fixtures/playwright'")) {
    violations.push({ file: relative(process.cwd(), file), rule: 'missing Playwright network/data fixture' })
  }
  if (
    file.includes('/tests/e2e/') &&
    /\brequest\.(?:get|post|put|patch|delete|fetch)\s*\(\s*['"]https?:\/\//.test(source)
  ) {
    violations.push({ file: relative(process.cwd(), file), rule: 'absolute external APIRequestContext URL' })
  }
}

const vitestSource = await readFile(resolve('vitest.config.ts'), 'utf8')
const vitestConfig = (await import('../vitest.config')).default
const nodeConfig = (await import('../vitest.node.config')).default
const projects = vitestConfig.test?.projects as Array<{
  test?: { name?: string; setupFiles?: string | string[] }
}>
const guarded = (project: (typeof projects)[number]) => {
  const setup = project.test?.setupFiles
  return (Array.isArray(setup) ? setup : [setup]).includes('tests/support/no-external-network.ts')
}
if (
  projects.length !== 4 ||
  projects.map((project) => project.test?.name).join(',') !== 'unit,nuxt,component,integration' ||
  !projects.every(guarded) ||
  nodeConfig.test?.projects?.length !== 1 ||
  !guarded(nodeConfig.test.projects[0] as (typeof projects)[number])
) {
  violations.push({ file: 'vitest.config.ts', rule: 'external network guard must cover every Vitest project' })
}
if (!vitestSource.includes('sequence: { concurrent: false }')) {
  violations.push({ file: 'vitest.config.ts', rule: 'integration tests must not share state concurrently' })
}
if (!vitestSource.includes("globalSetup: ['tests/support/integration-global-setup.ts']")) {
  violations.push({ file: 'vitest.config.ts', rule: 'integration database template setup is required' })
}
const playwrightConfig = await readFile(resolve('playwright.config.ts'), 'utf8')
if (!playwrightConfig.includes("NETECO_TEST_NOW: '2026-08-13T12:00:00.000Z'")) {
  violations.push({ file: 'playwright.config.ts', rule: 'fixed application clock is required for E2E' })
}

if (violations.length > 0) {
  throw new Error(
    `Test determinism audit failed:\n${violations.map((violation) => `- ${violation.file}: ${violation.rule}`).join('\n')}`
  )
}

const result = {
  schemaVersion: 1,
  filesChecked: files.length,
  forbiddenSources: rules.map((rule) => rule.name),
  networkGuards: ['vitest-fetch', 'vitest-undici-dispatcher', 'playwright-browser'],
  databaseIsolation: 'postgres-template-clone-per-integration-test',
  clock: 'fixed-in-test-environment',
  integrationConcurrency: 'serial',
  status: 'passed'
}
if (process.argv.includes('--publish')) {
  await mkdir(resolve('test-results'), { recursive: true })
  await writeFile(resolve('test-results/determinism.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}
process.stdout.write(
  `test-determinism files=${files.length} forbidden-sources=0 network-guards=3 integration=serial${
    process.argv.includes('--publish') ? ' published=test-results/determinism.json' : ''
  }\n`
)
