import { describe, expect, it } from 'vitest'
import {
  aggregateFlakeObservations,
  runFlakeObservation,
  flakeShardCommands,
  type FlakeObservationPorts
} from '../../scripts/lib/flake-observations'

const meta = { commit: 'a'.repeat(40), runId: '42', attempt: '1' }
const projects = ['unit', 'nuxt', 'component', 'integration']
function fixture() {
  const files = new Map<string, string>(),
    commands: string[][] = []
  files.set('test-results/ui013-components/transport-marker.html', 'component capture transport fixture')
  let failFirst = false
  const ports: FlakeObservationPorts = {
    async execute(command, args) {
      commands.push([command, ...args])
      if (command === 'npm') return { exitCode: 0 }
      const project = args[args.indexOf('--project') + 1]!
      const path = args.find((arg) => arg.startsWith('--outputFile.json='))!.slice('--outputFile.json='.length)
      const failed = failFirst && path.startsWith('/fresh-1/') && project === 'unit'
      files.set(
        path,
        JSON.stringify({
          success: !failed,
          testResults: [
            {
              name: `/repo/tests/${project === 'component' ? 'components' : project}/case.test.ts`,
              assertionResults: [{ fullName: 'real behavior', status: failed ? 'failed' : 'passed' }]
            }
          ]
        })
      )
      const junit = args.find((arg) => arg.startsWith('--outputFile.junit='))!.slice('--outputFile.junit='.length)
      files.set(junit, '<testsuites><testsuite><testcase name="real behavior"/></testsuite></testsuites>')
      const coverage = args.find((arg) => arg.startsWith('--coverage.reportsDirectory='))
      if (coverage)
        files.set(
          coverage.slice('--coverage.reportsDirectory='.length) + '/coverage-summary.json',
          '{"total":{"lines":{"pct":100}}}'
        )
      return { exitCode: failed ? 1 : 0 }
    },
    async read(path) {
      const data = files.get(path)
      if (data === undefined) throw Error('missing')
      return data
    },
    async write(path, data) {
      files.set(path, data)
    },
    async publish(source, target) {
      const matching = [...files].filter(([name]) => name === source || name.startsWith(source + '/'))
      if (!matching.length) throw Error('missing publication source')
      for (const [name, data] of matching) files.set(target + name.slice(source.length), data)
    }
  }
  return {
    ports,
    files,
    commands,
    fail: () => {
      failFirst = true
    }
  }
}
async function observations(f: ReturnType<typeof fixture>) {
  for (const observation of [1, 2] as const)
    await runFlakeObservation(f.ports, `/fresh-${observation}`, '/repo', { ...meta, observation })
}

describe('two complete Oracle flake observations with a blocking aggregate', () => {
  it('executes all four projects in each observation, coverage once, with at most two workers', () => {
    const first = flakeShardCommands('/fresh-1', 1),
      second = flakeShardCommands('/fresh-2', 2)
    expect(first.map((row) => row.project)).toEqual(projects)
    expect(second.map((row) => row.project)).toEqual(projects)
    expect(first.filter((row) => row.args.includes('--coverage')).map((row) => row.project)).toEqual(['unit'])
    expect(second.flatMap((row) => row.args)).not.toContain('--coverage')
    for (const row of [...first, ...second])
      expect(row.args).toContain(['unit', 'component'].includes(row.project) ? '--maxWorkers=2' : '--maxWorkers=1')
  })
  it('retains the same two complete case sets and canonical CI artifacts without rerunning tests in aggregation', async () => {
    const f = fixture()
    await observations(f)
    const before = f.commands.length
    const report = await aggregateFlakeObservations(f.ports, 'test-results', '/repo', meta)
    expect(report).toMatchObject({ status: 'passed', repetitions: 2, distinctTests: 4, executions: 8, flakyRate: 0 })
    expect(f.commands.slice(before).every(([command]) => command === 'npm')).toBe(true)
    expect(f.commands.filter(([command]) => command.includes('vitest'))).toHaveLength(8)
    expect(JSON.parse(f.files.get('test-results/vitest-observation-2-all.json')!).testResults).toHaveLength(4)
    for (const project of projects) expect(f.files.has(`test-results/${project}.xml`)).toBe(true)
    expect(f.files.has('coverage/coverage-summary.json')).toBe(true)
  })
  it('carries current component captures through the first artifact into the visual job', async () => {
    const f = fixture()
    await observations(f)
    expect(f.files.get('test-results/flake-observation-1/ui013-components/transport-marker.html')).toBe(
      'component capture transport fixture'
    )
    f.files.delete('test-results/ui013-components/transport-marker.html')
    expect((await aggregateFlakeObservations(f.ports, 'test-results', '/repo', meta)).status).toBe('passed')
    expect(f.files.get('test-results/ui013-components/transport-marker.html')).toBe(
      'component capture transport fixture'
    )
  })
  it('blocks promotion when the first component capture was not produced', async () => {
    const f = fixture()
    f.files.delete('test-results/ui013-components/transport-marker.html')
    expect((await runFlakeObservation(f.ports, '/fresh-1', '/repo', { ...meta, observation: 1 })).status).toBe('failed')
  })
  it('keeps an earlier failure red after a complete passing second observation', async () => {
    const f = fixture()
    f.fail()
    await observations(f)
    const report = await aggregateFlakeObservations(f.ports, 'test-results', '/repo', meta)
    expect(report.status).toBe('failed')
    expect(f.commands.filter(([command]) => command.includes('vitest'))).toHaveLength(8)
    expect(f.files.has('test-results/flake-observation-1/vitest-unit.json')).toBe(true)
  })
  it.each([
    'wrong-commit',
    'wrong-run',
    'wrong-attempt',
    'missing-project',
    'duplicate-project',
    'missing-report',
    'missing-junit',
    'missing-coverage',
    'empty-tests',
    'malformed-json',
    'missing-second'
  ])('rejects %s evidence and never substitutes stale or empty results', async (mode) => {
    const f = fixture()
    await observations(f)
    const root = 'test-results/flake-observation-2'
    const manifest = JSON.parse(f.files.get(root + '/observation.json')!)
    if (mode === 'wrong-commit') {
      manifest.commit = 'b'.repeat(40)
      f.files.set(root + '/observation.json', JSON.stringify(manifest))
    }
    if (mode === 'wrong-run') {
      manifest.runId = '43'
      f.files.set(root + '/observation.json', JSON.stringify(manifest))
    }
    if (mode === 'wrong-attempt') {
      manifest.attempt = '2'
      f.files.set(root + '/observation.json', JSON.stringify(manifest))
    }
    if (mode === 'missing-project') {
      manifest.projects.pop()
      f.files.set(root + '/observation.json', JSON.stringify(manifest))
    }
    if (mode === 'duplicate-project') {
      manifest.projects[3] = 'unit'
      f.files.set(root + '/observation.json', JSON.stringify(manifest))
    }
    if (mode === 'missing-report') f.files.delete(root + '/vitest-unit.json')
    if (mode === 'missing-junit') f.files.delete('test-results/flake-observation-1/unit.xml')
    if (mode === 'missing-coverage') f.files.delete('test-results/flake-observation-1/coverage/coverage-summary.json')
    if (mode === 'empty-tests') f.files.set(root + '/vitest-unit.json', '{"success":true,"testResults":[]}')
    if (mode === 'malformed-json') f.files.set(root + '/vitest-unit.json', '{')
    if (mode === 'missing-second') f.files.delete(root + '/observation.json')
    expect((await aggregateFlakeObservations(f.ports, 'test-results', '/repo', meta)).status).toBe('failed')
  })
})
