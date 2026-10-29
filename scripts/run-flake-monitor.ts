import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runFlakeObservations } from './lib/flake-monitor'

const execFileAsync = promisify(execFile)
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'neteco-flake-monitor-'))
try {
  const report = await runFlakeObservations(
    {
      async execute(command, args) {
        try {
          const result = await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024 })
          process.stdout.write(result.stdout)
          process.stderr.write(result.stderr)
          return { exitCode: 0 }
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string }
          process.stdout.write(failure.stdout ?? '')
          process.stderr.write(failure.stderr ?? '')
          return { exitCode: 1 }
        }
      },
      read: (path) => readFile(path, 'utf8'),
      async publish(source, target) {
        await mkdir(resolve('test-results'), { recursive: true })
        await cp(source, resolve(target), { recursive: true, force: true })
      }
    },
    temporaryDirectory,
    process.cwd()
  )
  await mkdir(resolve('test-results'), { recursive: true })
  await writeFile(resolve('test-results/flaky-rate.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `flake-monitor suite=vitest-all-projects repetitions=${report.repetitions} tests=${report.distinctTests} rate=${report.flakyRate} status=${report.status}\n`
  )
  if (report.status !== 'passed') {
    throw new Error(
      `Flake monitor failed: inconsistent=${report.flakyTests.length} failing=${report.failingTests.length} infrastructure=${report.failures.length}`
    )
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
