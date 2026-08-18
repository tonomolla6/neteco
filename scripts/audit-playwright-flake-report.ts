import { readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface JsonSuite {
  title: string
  suites?: JsonSuite[]
  specs?: Array<{
    title: string
    file: string
    tests: Array<{
      projectName: string
      status: string
      results: Array<{ status: string }>
    }>
  }>
}

interface JsonReport {
  suites?: JsonSuite[]
}

const source = resolve('test-results/flaky-browser-raw.json')
try {
  const value = JSON.parse(await readFile(source, 'utf8')) as JsonReport
  const executions = new Map<string, string[]>()
  function collect(suite: JsonSuite, parents: string[] = []) {
    const titles = suite.title ? [...parents, suite.title] : parents
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const key = `${test.projectName}::${spec.file}::${[...titles, spec.title].join(' > ')}`
        const statuses = executions.get(key) ?? []
        statuses.push(test.results.at(-1)?.status ?? test.status)
        executions.set(key, statuses)
      }
    }
    for (const child of suite.suites ?? []) collect(child, titles)
  }
  for (const suite of value.suites ?? []) collect(suite)

  const flakyTests: string[] = []
  const failingTests: string[] = []
  for (const [test, statuses] of executions) {
    if (statuses.length !== 2 || new Set(statuses).size !== 1) flakyTests.push(test)
    if (statuses.length !== 2 || statuses.some((status) => status !== 'passed')) failingTests.push(test)
  }
  const report = {
    schemaVersion: 1,
    suite: 'playwright-browser-matrix',
    repetitions: 2,
    distinctTests: executions.size,
    executions: [...executions.values()].reduce((total, statuses) => total + statuses.length, 0),
    flakyTests: flakyTests.sort(),
    failingTests: failingTests.sort(),
    flakyRate: executions.size === 0 ? 0 : flakyTests.length / executions.size,
    status: executions.size > 0 && flakyTests.length === 0 && failingTests.length === 0 ? 'passed' : 'failed'
  }
  await writeFile(resolve('test-results/flaky-browser-rate.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `flake-monitor suite=playwright-browser-matrix repetitions=2 tests=${report.distinctTests} rate=${report.flakyRate} status=${report.status}\n`
  )
  if (report.status !== 'passed') {
    throw new Error(`Browser flake monitor failed: inconsistent=${flakyTests.length} failing=${failingTests.length}`)
  }
} finally {
  await unlink(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}
