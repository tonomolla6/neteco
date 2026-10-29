import { join } from 'node:path'
import { repeatedRunReport, vitestExecutions } from './flaky-policy'

export const FLAKE_PROJECTS = ['unit', 'nuxt', 'component', 'integration'] as const
export interface FlakeMonitorPorts {
  execute(command: string, args: string[]): Promise<{ exitCode: number }>
  read(path: string): Promise<string>
  publish(source: string, target: string): Promise<void>
}
export function flakeObservationCommands(directory: string) {
  const base = ['run', '--maxWorkers=1', '--no-file-parallelism', '--reporter=default', '--reporter=json']
  return [
    ...FLAKE_PROJECTS.map((project) => ({
      project,
      json: join(directory, `first-${project}.json`),
      junit: join(directory, `${project}.xml`),
      args: [
        ...base,
        ...(project === 'unit'
          ? [
              '--config',
              'vitest.node.config.ts',
              '--coverage',
              `--coverage.reportsDirectory=${join(directory, 'coverage')}`
            ]
          : []),
        '--project',
        project,
        '--reporter=junit',
        `--outputFile.json=${join(directory, `first-${project}.json`)}`,
        `--outputFile.junit=${join(directory, `${project}.xml`)}`
      ]
    })),
    {
      project: 'all',
      json: join(directory, 'second-all.json'),
      junit: null,
      args: [...base, `--outputFile.json=${join(directory, 'second-all.json')}`]
    }
  ]
}
export async function runFlakeObservations(ports: FlakeMonitorPorts, directory: string, repositoryRoot: string) {
  const failures: string[] = [],
    runs: [ReturnType<typeof vitestExecutions>, ReturnType<typeof vitestExecutions>] = [[], []]
  async function execute(command: string, args: string[], label: string) {
    try {
      if ((await ports.execute(command, args)).exitCode !== 0) failures.push(`${label}: command failed`)
    } catch {
      failures.push(`${label}: command unavailable`)
    }
  }
  async function publish(source: string, target: string) {
    try {
      await ports.publish(source, target)
    } catch {
      failures.push(`${target}: publication failed`)
    }
  }
  await execute('npm', ['run', 'coverage:policy'], 'coverage policy before')
  for (const observation of flakeObservationCommands(directory)) {
    await execute('node_modules/.bin/vitest', observation.args, observation.project)
    try {
      const source = await ports.read(observation.json)
      await publish(
        observation.json,
        `test-results/vitest-${observation.project === 'all' ? 'observation-2-all' : `observation-1-${observation.project}`}.json`
      )
      const report = JSON.parse(source) as Parameters<typeof vitestExecutions>[0] & { success?: boolean }
      const executions = vitestExecutions(report, repositoryRoot)
      if (!executions.length || report.success === false)
        failures.push(`${observation.project}: empty or unsuccessful report`)
      runs[observation.project === 'all' ? 1 : 0].push(...executions)
    } catch {
      failures.push(`${observation.project}: missing or malformed JSON report`)
    }
    if (observation.junit) {
      try {
        const junit = await ports.read(observation.junit)
        await publish(observation.junit, `test-results/${observation.project}.xml`)
        if (!/<testsuites?\b/.test(junit) || !/<testcase\b/.test(junit)) throw new Error('invalid_junit')
      } catch {
        failures.push(`${observation.project}: missing or malformed fresh JUnit`)
      }
    }
    if (observation.project === 'unit') {
      try {
        const source = await ports.read(join(directory, 'coverage/coverage-summary.json'))
        await publish(join(directory, 'coverage'), 'coverage')
        const summary = JSON.parse(source) as {
          total?: unknown
        }
        if (!summary.total) throw new Error('missing_coverage')
      } catch {
        failures.push('unit: missing fresh coverage')
      }
    }
  }
  await execute('npm', ['run', 'coverage:policy', '--', '--publish'], 'coverage policy after')
  const report = repeatedRunReport(runs)
  return {
    ...report,
    suite: 'vitest-all-projects',
    policy: 'zero-tolerance',
    failures,
    status: failures.length ? ('failed' as const) : report.status
  }
}
