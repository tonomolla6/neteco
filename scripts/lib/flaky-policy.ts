export interface TestExecution {
  file: string
  name: string
  status: string
}

interface VitestJson {
  testResults?: Array<{
    name: string
    assertionResults?: Array<{ fullName: string; status: string }>
  }>
}

export function vitestExecutions(report: VitestJson, repositoryRoot: string): TestExecution[] {
  return (report.testResults ?? []).flatMap((file) => {
    const assertions = file.assertionResults ?? []
    const totals = new Map<string, number>()
    for (const test of assertions) totals.set(test.fullName, (totals.get(test.fullName) ?? 0) + 1)
    const occurrences = new Map<string, number>()
    return assertions.map((test) => {
      const occurrence = (occurrences.get(test.fullName) ?? 0) + 1
      occurrences.set(test.fullName, occurrence)
      return {
        file: file.name.startsWith(`${repositoryRoot}/`) ? file.name.slice(repositoryRoot.length + 1) : file.name,
        name: totals.get(test.fullName)! > 1 ? `${test.fullName} [case ${occurrence}]` : test.fullName,
        status: test.status
      }
    })
  })
}

export function repeatedRunReport(runs: TestExecution[][]) {
  const byTest = new Map<string, string[]>()
  for (const run of runs) {
    for (const test of run) {
      const key = `${test.file}::${test.name}`
      byTest.set(key, [...(byTest.get(key) ?? []), test.status])
    }
  }
  const expectedExecutions = runs.length
  const flakyTests: string[] = []
  const failingTests: string[] = []
  for (const [test, statuses] of byTest) {
    if (statuses.length !== expectedExecutions || new Set(statuses).size !== 1) flakyTests.push(test)
    if (statuses.length !== expectedExecutions || statuses.some((status) => status !== 'passed'))
      failingTests.push(test)
  }
  return {
    schemaVersion: 1,
    repetitions: runs.length,
    distinctTests: byTest.size,
    executions: runs.reduce((total, run) => total + run.length, 0),
    flakyTests: flakyTests.sort(),
    failingTests: failingTests.sort(),
    flakyRate: byTest.size === 0 ? 0 : flakyTests.length / byTest.size,
    status:
      byTest.size > 0 && flakyTests.length === 0 && failingTests.length === 0
        ? ('passed' as const)
        : ('failed' as const)
  }
}

export function forbiddenTestControls(source: string) {
  const controls = [
    { name: 'skipped test', pattern: /\b(?:test|it|describe)(?:\.describe)?\.skip\s*\(/ },
    { name: 'todo test', pattern: /\b(?:test|it)\.todo\s*\(/ },
    { name: 'focused test', pattern: /\b(?:test|it|describe)(?:\.describe)?\.only\s*\(/ },
    { name: 'expected failing test', pattern: /\b(?:test|it)\.fails\s*\(/ },
    { name: 'Playwright fixme', pattern: /\btest\.fixme\s*\(/ }
  ]
  return controls.filter((control) => control.pattern.test(source)).map((control) => control.name)
}
