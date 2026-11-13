import { join } from 'node:path'
import { z } from 'zod'
import { FLAKE_PROJECTS, type FlakeMonitorPorts } from './flake-monitor'
import { repeatedRunReport, vitestExecutions, type TestExecution } from './flaky-policy'

export interface FlakeObservationPorts extends FlakeMonitorPorts {
  write(path: string, content: string): Promise<void>
}
const identity = z.object({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  runId: z.string().regex(/^[1-9][0-9]*$/),
  attempt: z.string().regex(/^[1-9][0-9]*$/)
})
const manifestSchema = identity.extend({
  schemaVersion: z.literal(1),
  observation: z.union([z.literal(1), z.literal(2)]),
  projects: z.tuple([z.literal('unit'), z.literal('nuxt'), z.literal('component'), z.literal('integration')]),
  failures: z.array(z.string()),
  status: z.enum(['passed', 'failed'])
})
const reportSchema = z
  .object({
    success: z.boolean(),
    testResults: z
      .array(
        z
          .object({
            name: z.string().min(1),
            assertionResults: z.array(z.object({ fullName: z.string(), status: z.string() }).passthrough()).min(1)
          })
          .passthrough()
      )
      .min(1)
  })
  .passthrough()
type Report = z.infer<typeof reportSchema>
type Identity = z.input<typeof identity>

export function flakeShardCommands(directory: string, observation: 1 | 2) {
  return FLAKE_PROJECTS.map((project) => {
    const parallel = project === 'unit' || project === 'component'
    return {
      project,
      json: join(directory, `vitest-${project}.json`),
      junit: join(directory, `${project}.xml`),
      args: [
        'run',
        `--maxWorkers=${parallel ? 2 : 1}`,
        ...(!parallel ? ['--no-file-parallelism'] : []),
        ...(project === 'unit' ? ['--config', 'vitest.node.config.ts'] : []),
        ...(project === 'unit' && observation === 1
          ? ['--coverage', `--coverage.reportsDirectory=${join(directory, 'coverage')}`]
          : []),
        '--project',
        project,
        '--reporter=default',
        '--reporter=json',
        '--reporter=junit',
        `--outputFile.json=${join(directory, `vitest-${project}.json`)}`,
        `--outputFile.junit=${join(directory, `${project}.xml`)}`
      ]
    }
  })
}
function hasJunit(value: string) {
  return /<testsuites?\b/.test(value) && /<testcase\b/.test(value)
}
async function policy(ports: FlakeObservationPorts, failures: string[], publish = false) {
  try {
    const result = await ports.execute('npm', ['run', 'coverage:policy', ...(publish ? ['--', '--publish'] : [])])
    if (result.exitCode !== 0) failures.push('coverage policy failed')
  } catch {
    failures.push('coverage policy unavailable')
  }
}

/** Two independent Oracle jobs each execute every project. No job weakens the
 * repetition policy, drops a project or increases a test/job timeout. */
export async function runFlakeObservation(
  ports: FlakeObservationPorts,
  directory: string,
  repositoryRoot: string,
  input: Identity & { observation: 1 | 2 }
) {
  const meta = identity.parse(input),
    failures: string[] = []
  if (![1, 2].includes(input.observation)) throw new Error('invalid_flake_observation')
  const output = `test-results/flake-observation-${input.observation}`
  if (input.observation === 1) await policy(ports, failures)
  for (const command of flakeShardCommands(directory, input.observation)) {
    try {
      if ((await ports.execute('node_modules/.bin/vitest', command.args)).exitCode !== 0)
        failures.push(`${command.project}: command failed`)
    } catch {
      failures.push(`${command.project}: command unavailable`)
    }
    try {
      const source = await ports.read(command.json)
      await ports.publish(command.json, `${output}/vitest-${command.project}.json`)
      const report = reportSchema.parse(JSON.parse(source))
      if (!report.success || !vitestExecutions(report, repositoryRoot).length)
        failures.push(`${command.project}: unsuccessful report`)
    } catch {
      failures.push(`${command.project}: missing or malformed report`)
    }
    try {
      const junit = await ports.read(command.junit)
      await ports.publish(command.junit, `${output}/${command.project}.xml`)
      if (!hasJunit(junit)) failures.push(`${command.project}: malformed JUnit`)
    } catch {
      failures.push(`${command.project}: missing JUnit`)
    }
  }
  if (input.observation === 1) {
    try {
      await ports.publish('test-results/ui013-components', `${output}/ui013-components`)
    } catch {
      failures.push('missing current component captures')
    }
    try {
      if (!JSON.parse(await ports.read(join(directory, 'coverage/coverage-summary.json'))).total)
        throw Error('missing total')
      await ports.publish(join(directory, 'coverage'), `${output}/coverage`)
    } catch {
      failures.push('missing fresh coverage')
    }
  }
  const manifest = {
    schemaVersion: 1 as const,
    ...meta,
    observation: input.observation,
    projects: [...FLAKE_PROJECTS],
    failures,
    status: failures.length ? ('failed' as const) : ('passed' as const)
  }
  await ports.write(`${output}/observation.json`, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

export async function aggregateFlakeObservations(
  ports: FlakeObservationPorts,
  directory: string,
  repositoryRoot: string,
  input: Identity
) {
  const meta = identity.parse(input),
    failures: string[] = [],
    runs: [TestExecution[], TestExecution[]] = [[], []],
    second: Report[] = []
  for (const observation of [1, 2] as const) {
    const source = join(directory, `flake-observation-${observation}`)
    try {
      const manifest = manifestSchema.parse(JSON.parse(await ports.read(join(source, 'observation.json'))))
      if (
        manifest.observation !== observation ||
        manifest.commit !== meta.commit ||
        manifest.runId !== meta.runId ||
        manifest.attempt !== meta.attempt
      )
        throw Error('stale observation')
      if (manifest.status !== 'passed' || manifest.failures.length)
        failures.push(`observation ${observation}: execution failed`)
      for (const project of FLAKE_PROJECTS) {
        const path = join(source, `vitest-${project}.json`)
        const report = reportSchema.parse(JSON.parse(await ports.read(path)))
        if (!report.success) failures.push(`observation ${observation}/${project}: unsuccessful report`)
        runs[observation - 1]!.push(...vitestExecutions(report, repositoryRoot))
        if (!hasJunit(await ports.read(join(source, `${project}.xml`)))) throw Error('missing fresh JUnit')
        if (observation === 1) {
          await ports.publish(path, `test-results/vitest-observation-1-${project}.json`)
          await ports.publish(join(source, `${project}.xml`), `test-results/${project}.xml`)
        } else second.push(report)
      }
      if (observation === 1) {
        if (!JSON.parse(await ports.read(join(source, 'coverage/coverage-summary.json'))).total)
          throw Error('missing fresh coverage')
        await ports.publish(join(source, 'coverage'), 'coverage')
        await ports.publish(join(source, 'ui013-components'), 'test-results/ui013-components')
      }
    } catch {
      failures.push(`observation ${observation}: missing, malformed or stale evidence`)
    }
  }
  // This canonical reporter document contains the unchanged cases from all four
  // real second runs; no outcome is synthesized or substituted for a failed run.
  await ports.write(
    'test-results/vitest-observation-2-all.json',
    JSON.stringify(
      {
        success: second.length === 4 && second.every((report) => report.success),
        testResults: second.flatMap((report) => report.testResults)
      },
      null,
      2
    ) + '\n'
  )
  await policy(ports, failures, true)
  const report = repeatedRunReport(runs)
  return {
    ...report,
    suite: 'vitest-all-projects',
    policy: 'zero-tolerance',
    failures,
    status: failures.length ? ('failed' as const) : report.status
  }
}
