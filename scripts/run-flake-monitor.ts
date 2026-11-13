import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runFlakeObservations } from './lib/flake-monitor'
import { aggregateFlakeObservations, runFlakeObservation, type FlakeObservationPorts } from './lib/flake-observations'

const execFileAsync = promisify(execFile)
const temporaryDirectory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'neteco-flake-monitor-'))
try {
  const ports: FlakeObservationPorts = {
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
      await mkdir(resolve(target, '..'), { recursive: true })
      await cp(source, resolve(target), { recursive: true, force: true })
    },
    async write(path, content) {
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(resolve(path), content, 'utf8')
    }
  }
  const observation = process.env.NETECO_FLAKE_OBSERVATION
  const artifacts = process.env.NETECO_FLAKE_ARTIFACTS
  if (observation && artifacts) throw new Error('ambiguous_flake_mode')
  const identity = async () => {
    const commit = process.env.GITHUB_SHA ?? ''
    const runId = process.env.GITHUB_RUN_ID ?? ''
    const attempt = process.env.GITHUB_RUN_ATTEMPT ?? ''
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(attempt))
      throw new Error('missing_flake_run_identity')
    const head = await execFileAsync('git', ['rev-parse', 'HEAD'])
    if (head.stdout.trim() !== commit) throw new Error('flake_checkout_identity_mismatch')
    return { commit, runId, attempt }
  }
  if (observation) {
    if (observation !== '1' && observation !== '2') throw new Error('invalid_flake_observation')
    const manifest = await runFlakeObservation(ports, temporaryDirectory, process.cwd(), {
      ...(await identity()),
      observation: observation === '1' ? 1 : 2
    })
    process.stdout.write(
      `flake-observation=${observation} status=${manifest.status} failures=${manifest.failures.length}\n`
    )
    if (manifest.status !== 'passed') process.exitCode = 1
  } else {
    const report = artifacts
      ? await aggregateFlakeObservations(ports, resolve(artifacts), process.cwd(), await identity())
      : await runFlakeObservations(ports, temporaryDirectory, process.cwd())
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
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
