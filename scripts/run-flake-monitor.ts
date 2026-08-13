import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { repeatedRunReport, vitestExecutions } from './lib/flaky-policy'

const execFileAsync = promisify(execFile)
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'neteco-flake-monitor-'))
const runs = []
try {
  for (let repetition = 1; repetition <= 2; repetition += 1) {
    const reportPath = join(temporaryDirectory, `vitest-${repetition}.json`)
    try {
      await execFileAsync('node_modules/.bin/vitest', ['run', '--reporter=json', `--outputFile=${reportPath}`])
    } catch {
      // Preserve both independent executions so a pass-after-failure is evidence, never a green retry.
    }
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as Parameters<typeof vitestExecutions>[0]
    runs.push(vitestExecutions(report, process.cwd()))
  }
  const report = { ...repeatedRunReport(runs), suite: 'vitest-all-projects', policy: 'zero-tolerance' }
  await mkdir(resolve('test-results'), { recursive: true })
  await writeFile(resolve('test-results/flaky-rate.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `flake-monitor suite=vitest-all-projects repetitions=${report.repetitions} tests=${report.distinctTests} rate=${report.flakyRate} status=${report.status}\n`
  )
  if (report.status !== 'passed') {
    throw new Error(
      `Flake monitor failed: inconsistent=${report.flakyTests.length} failing=${report.failingTests.length}`
    )
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
