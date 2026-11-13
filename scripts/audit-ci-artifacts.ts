import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inventoryAndRedactArtifacts } from './lib/ci-artifacts'
import { FLAKE_PROJECTS } from './lib/flake-monitor'
import { flakeShardCommands } from './lib/flake-observations'

interface ArtifactPolicy {
  schemaVersion: number
  requirementId: string
  retentionDays: Record<string, number>
  evidence: Record<string, string[]>
}

const [workflow, packageSource, playwright, accessibility, matrix, visual, policySource, monitor] = await Promise.all([
  readFile(resolve('.github/workflows/ci.yml'), 'utf8'),
  readFile(resolve('package.json'), 'utf8'),
  readFile(resolve('playwright.config.ts'), 'utf8'),
  readFile(resolve('playwright.a11y.config.ts'), 'utf8'),
  readFile(resolve('playwright.matrix.config.ts'), 'utf8'),
  readFile(resolve('playwright.visual.config.ts'), 'utf8'),
  readFile(resolve('docs/testing/ci-artifacts.json'), 'utf8'),
  readFile(resolve('scripts/run-flake-monitor.ts'), 'utf8')
])
const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> }
const policy = JSON.parse(policySource) as ArtifactPolicy
const failures: string[] = []
const requireText = (source: string, token: string, message: string) => {
  if (!source.includes(token)) failures.push(message)
}

if (policy.schemaVersion !== 1 || policy.requirementId !== 'TST-036') failures.push('invalid artifact policy identity')
for (const [name, days] of Object.entries({
  qualityEvidence: 14,
  applicationSbom: 14,
  mutationEvidence: 14,
  containerEvidence: 3,
  workflowLogs: 14
})) {
  if (policy.retentionDays[name] !== days) failures.push(`retention mismatch for ${name}`)
}
for (const category of ['junit', 'coverage', 'traces', 'screenshots', 'logs', 'sbom', 'performance', 'chaos']) {
  if (!policy.evidence[category]?.length) failures.push(`missing evidence policy for ${category}`)
}
for (const [script, report] of Object.entries({
  coverage: 'test-results/unit.xml',
  'test:nuxt': 'test-results/nuxt.xml',
  'test:component': 'test-results/component.xml',
  'test:integration': 'test-results/integration.xml'
})) {
  const command = packageJson.scripts[script] ?? ''
  requireText(command, '--reporter=junit', `${script} does not publish JUnit`)
  requireText(command, report, `${script} does not target ${report}`)
}
// Inspect the same effective command plan used by the monitor, not only the
// standalone developer scripts that CI no longer executes a third time.
for (const repetition of [1, 2] as const) {
  const observations = flakeShardCommands('/fresh-monitor', repetition)
  if (observations.length !== FLAKE_PROJECTS.length) failures.push(`observation ${repetition}: missing projects`)
  for (const [index, project] of FLAKE_PROJECTS.entries()) {
    const observation = observations[index]!
    for (const token of [
      '--reporter=junit',
      '--reporter=json',
      '--project',
      project,
      `--maxWorkers=${project === 'unit' || project === 'component' ? 2 : 1}`,
      `--outputFile.junit=/fresh-monitor/${project}.xml`
    ])
      if (!observation.args.includes(token)) failures.push(`observation ${repetition}/${project}: missing ${token}`)
    const coverage = repetition === 1 && project === 'unit'
    if (observation.args.includes('--coverage') !== coverage)
      failures.push('coverage must run once on the full unit suite')
  }
}
for (const token of ['runFlakeObservation(', 'aggregateFlakeObservations(', 'GITHUB_RUN_ATTEMPT'])
  requireText(monitor, token, `monitor does not execute fresh audited observation plan: ${token}`)
requireText(workflow, 'npm run test:flake-monitor', 'CI does not run evidence-producing monitor')
for (const script of ['coverage', 'test:nuxt', 'test:component', 'test:integration'])
  if (workflow.split('\n').some((line) => line.trim() === `- run: npm run ${script}`))
    failures.push(`CI redundantly runs third ${script} observation`)
for (const prerequisite of ['db:migrate', 'db:seed']) {
  const index = workflow.indexOf(`- run: npm run ${prerequisite}`)
  if (index < 0 || index > workflow.indexOf('- run: npm run test:flake-monitor'))
    failures.push(`${prerequisite} must precede integration observations`)
}
requireText(
  packageJson.scripts['test:a11y'] ?? '',
  '--config=playwright.a11y.config.ts',
  'test:a11y does not use its isolated JUnit reporter'
)
for (const [source, report] of [
  [playwright, 'test-results/e2e.xml'],
  [accessibility, 'test-results/accessibility.xml'],
  [matrix, 'test-results/browser-matrix.xml'],
  [visual, 'test-results/visual.xml']
]) {
  requireText(source, "['junit'", `Playwright reporter missing for ${report}`)
  requireText(source, report, `Playwright reporter does not target ${report}`)
}
for (const token of ["trace: 'retain-on-failure'", "screenshot: 'only-on-failure'"]) {
  requireText(playwright, token, `Playwright diagnostics policy missing ${token}`)
}
requireText(playwright, "outputDir: 'test-results/e2e'", 'Playwright can erase reports produced by earlier CI suites')
for (const token of [
  'npm run ci:artifacts',
  'npm run ci:artifacts -- --publish',
  'coverage/',
  'test-results/',
  'sbom.cdx.json',
  'retention-days: 14',
  'retention-days: 3',
  'upload-artifact: false'
]) {
  requireText(workflow, token, `CI artifact contract missing ${token}`)
}
if ((workflow.match(/retention-days: 14/g) ?? []).length < 2) failures.push('14-day artifact retention is incomplete')
if ((workflow.match(/retention-days: 3/g) ?? []).length < 1) failures.push('container retention is missing')
if (!workflow.includes("steps.complete-artifacts.outcome == 'success'")) {
  failures.push('quality artifacts can upload without successful redaction')
}
if ((workflow.match(/if: always\(\)/g) ?? []).length < 3) failures.push('diagnostic uploads are not failure-safe')
if (failures.length) throw new Error(`CI artifact audit failed:\n- ${failures.join('\n- ')}`)

if (process.argv.includes('--publish')) {
  const environmentKeys = [
    'DATABASE_URL',
    'REDIS_URL',
    'NUXT_SESSION_PASSWORD',
    'AUTH_TOKEN_PEPPER',
    'AUTH_ENCRYPTION_KEY',
    'EMAIL_WEBHOOK_SECRET',
    'REDSYS_SECRET_KEY',
    'NUXT_REDSYS_SECRET_KEY'
  ]
  const explicitSecrets = environmentKeys.map((key) => process.env[key] ?? '').filter(Boolean)
  const inventory = await inventoryAndRedactArtifacts(
    [
      'coverage',
      'test-results',
      'playwright-report',
      'playwright-a11y-report',
      'playwright-matrix-report',
      'playwright-visual-report',
      'reports/mutation',
      'sbom.cdx.json'
    ],
    explicitSecrets
  )
  const required = [
    'coverage/coverage-summary.json',
    'test-results/unit.xml',
    'test-results/nuxt.xml',
    'test-results/component.xml',
    'test-results/integration.xml',
    'test-results/e2e.xml',
    'test-results/accessibility.xml',
    'test-results/browser-matrix.xml',
    'test-results/visual.xml',
    'test-results/performance.json',
    'sbom.cdx.json'
  ]
  const missing = (
    await Promise.all(
      required.map(async (path) =>
        (await access(resolve(path))
          .then(() => true)
          .catch(() => false))
          ? ''
          : path
      )
    )
  ).filter(Boolean)
  const complete = missing.length === 0
  const output = resolve('test-results/ci-evidence.json')
  await mkdir(resolve('test-results'), { recursive: true })
  await writeFile(
    output,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        requirementId: 'TST-036',
        generatedAt: new Date().toISOString(),
        policy: 'docs/testing/ci-artifacts.json',
        status: complete ? 'complete' : 'partial',
        missing,
        ...inventory
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  process.stdout.write(
    `ci-artifacts=PASS status=${complete ? 'complete' : 'partial'} files=${inventory.files.length} redactedFiles=${inventory.redactedFiles} redactions=${inventory.redactions} output=${output}\n`
  )
  if (process.argv.includes('--require-complete') && !complete) {
    throw new Error(`Required CI artifacts are missing:\n- ${missing.join('\n- ')}`)
  }
} else {
  process.stdout.write('ci-artifacts=PASS policy=TST-036\n')
}
