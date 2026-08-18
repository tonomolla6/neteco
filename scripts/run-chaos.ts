import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { auditChaosSources, validateChaosPolicy } from './lib/chaos-policy'

const execFileAsync = promisify(execFile)
const policyPath = resolve('docs/testing/chaos-policy.json')
const runbookPath = resolve('docs/testing/chaos-recovery.md')
const workflowPath = resolve('.github/workflows/chaos.yml')
const outputPath = resolve('test-results/chaos.json')

const [policySource, runbookSource, workflowSource] = await Promise.all([
  readFile(policyPath, 'utf8'),
  readFile(runbookPath, 'utf8'),
  readFile(workflowPath, 'utf8')
])
const policy = validateChaosPolicy(JSON.parse(policySource) as unknown)
const testFiles = [...new Set(policy.scenarios.map(({ testFile }) => testFile))].sort()
const testSources = Object.fromEntries(
  await Promise.all(testFiles.map(async (file) => [file, await readFile(resolve(file), 'utf8')]))
)
const governanceProblems = auditChaosSources(policy, testSources, runbookSource, workflowSource)
if (governanceProblems.length) throw new Error(`Chaos governance failed:\n- ${governanceProblems.join('\n- ')}`)

let status: 'passed' | 'failed' = 'failed'
let failure: unknown
try {
  const result = await execFileAsync(
    'node_modules/.bin/vitest',
    [
      'run',
      '--project',
      'integration',
      '--maxWorkers=1',
      '--reporter=default',
      '--reporter=junit',
      '--outputFile.junit=test-results/chaos.xml',
      ...testFiles
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, NETECO_CHAOS_PROFILE: policy.profile },
      timeout: 5 * 60_000,
      maxBuffer: 20 * 1024 * 1024
    }
  )
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  const junit = await readFile(resolve('test-results/chaos.xml'), 'utf8')
  if (junit.includes('<skipped')) throw new Error('Chaos evidence contains skipped tests')
  const missingScenarios = policy.scenarios.filter(({ testName }) => !junit.includes(testName))
  if (missingScenarios.length) {
    throw new Error(`Chaos evidence is missing scenarios: ${missingScenarios.map(({ id }) => id).join(', ')}`)
  }
  status = 'passed'
} catch (error) {
  failure = error
  const result = error as Error & { stdout?: string; stderr?: string }
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

await mkdir(resolve('test-results'), { recursive: true })
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      requirementId: policy.requirementId,
      profile: policy.profile,
      status,
      policy: 'docs/testing/chaos-policy.json',
      schedule: policy.schedule,
      scenarios: policy.scenarios.map((scenario) => ({ ...scenario, status })),
      runbookRefs: ['docs/testing/chaos-recovery.md', 'docs/operations/incident-runbooks.md']
    },
    null,
    2
  )}\n`,
  'utf8'
)
process.stdout.write(`chaos=${status.toUpperCase()} scenarios=${policy.scenarios.length} output=${outputPath}\n`)
if (failure) throw failure
