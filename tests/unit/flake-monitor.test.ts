import { describe, expect, it } from 'vitest'
import { runFlakeObservations, type FlakeMonitorPorts } from '../../scripts/lib/flake-monitor'

function fixture(mode = 'passed') {
  const files = new Map<string, string>(),
    commands: string[][] = [],
    published: string[][] = []
  const ports: FlakeMonitorPorts = {
    async execute(command, args) {
      commands.push([command, ...args])
      if (command === 'npm')
        return { exitCode: mode === 'coverage-policy-failure' && args.includes('--publish') ? 1 : 0 }
      const project = args[args.indexOf('--project') + 1],
        second = !args.includes('--project')
      const projects = second ? ['unit', 'nuxt', 'component', 'integration'] : [project!]
      const report = {
        success: true,
        testResults: projects.map((name) => ({
          name: `/repo/tests/${name}/sample.test.ts`,
          assertionResults: [
            {
              fullName: 'real test',
              status: mode === 'first-failure' && !second && name === 'unit' ? 'failed' : 'passed'
            }
          ]
        }))
      }
      const json = args.find((arg) => arg.startsWith('--outputFile.json='))!.split('=')[1]!
      if (mode !== 'missing-report' || second)
        files.set(json, mode === 'malformed-report' && !second && project === 'unit' ? '{' : JSON.stringify(report))
      const junit = args.find((arg) => arg.startsWith('--outputFile.junit='))?.split('=')[1]
      if (junit && mode !== 'missing-junit')
        files.set(junit, '<testsuites><testsuite><testcase name="real test"/></testsuite></testsuites>')
      if (project === 'unit') files.set('/fresh/coverage/coverage-summary.json', '{"total":{"lines":{"pct":100}}}')
      return { exitCode: mode === 'coverage-exit-failure' && project === 'unit' ? 1 : 0 }
    },
    async read(path) {
      const content = files.get(path)
      if (content === undefined) throw new Error('missing')
      return content
    },
    async publish(source, target) {
      published.push([source, target])
    }
  }
  return { ports, commands, published }
}
describe('two independent flake observations with absorbed CI evidence', () => {
  it('executes four separate first projects and one all-project second observation, never a third', async () => {
    const f = fixture(),
      report = await runFlakeObservations(f.ports, '/fresh', '/repo')
    expect(report).toMatchObject({ status: 'passed', repetitions: 2, distinctTests: 4, executions: 8 })
    const vitest = f.commands.filter((command) => command[0] === 'node_modules/.bin/vitest')
    expect(vitest).toHaveLength(5)
    expect(vitest.slice(0, 4).map((command) => command[command.indexOf('--project') + 1])).toEqual([
      'unit',
      'nuxt',
      'component',
      'integration'
    ])
    expect(vitest[4]).not.toContain('--project')
    for (const command of vitest) {
      expect(command).toContain('--maxWorkers=1')
      expect(command).toContain('--no-file-parallelism')
    }
    expect(vitest[0]).toContain('vitest.node.config.ts')
    expect(vitest[0]).toContain('--coverage')
    expect(vitest.slice(1).flat()).not.toContain('--coverage')
    expect(f.commands[0]).toEqual(['npm', 'run', 'coverage:policy'])
    expect(f.commands.at(-1)).toEqual(['npm', 'run', 'coverage:policy', '--', '--publish'])
    expect(f.published.filter(([, target]) => target.endsWith('.xml')).map(([, target]) => target)).toEqual([
      'test-results/unit.xml',
      'test-results/nuxt.xml',
      'test-results/component.xml',
      'test-results/integration.xml'
    ])
    expect(f.published).toContainEqual(['/fresh/coverage', 'coverage'])
    expect(f.published.filter(([, target]) => target.endsWith('.json'))).toHaveLength(5)
  })
  it.each(['first-failure', 'missing-report', 'missing-junit', 'coverage-exit-failure', 'coverage-policy-failure'])(
    'keeps %s red despite the passing second observation',
    async (mode) => {
      const f = fixture(mode),
        report = await runFlakeObservations(f.ports, '/fresh', '/repo')
      expect(report.status).toBe('failed')
      expect(f.commands.filter((command) => command[0] === 'node_modules/.bin/vitest')).toHaveLength(5)
      expect(report.failures.length + report.failingTests.length).toBeGreaterThan(0)
    }
  )
  it('never accepts stale JUnit outside the fresh private execution directory', async () => {
    const f = fixture('missing-junit')
    const read = f.ports.read
    f.ports.read = async (path) =>
      path.startsWith('test-results/') ? '<testsuites><testcase/></testsuites>' : read(path)
    expect((await runFlakeObservations(f.ports, '/fresh', '/repo')).status).toBe('failed')
  })
  it('preserves malformed reporter evidence for diagnosis while failing closed', async () => {
    const f = fixture('malformed-report'),
      report = await runFlakeObservations(f.ports, '/fresh', '/repo')
    expect(report.status).toBe('failed')
    expect(f.published).toContainEqual(['/fresh/first-unit.json', 'test-results/vitest-observation-1-unit.json'])
  })
})
