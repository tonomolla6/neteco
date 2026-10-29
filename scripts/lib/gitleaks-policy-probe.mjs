import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const GITLEAKS_PROBE_VERSION = '8.24.3'
export const GITLEAKS_ARM64_ARCHIVE_SHA256 = '5f2edbe1f49f7b920f9e06e90759947d3c5dfc16f752fb93aaafc17e9d14cf07'

export const GITLEAKS_POLICY_CASES = Object.freeze([
  { id: 'control', path: 'control.txt', detect: true },
  { id: 'environment_example', path: '.env.example', detect: true },
  { id: 'screenshots', path: 'scripts/screenshots.mjs', detect: true },
  { id: 'redsys_fixture', path: 'tests/unit/redsys.test.ts', detect: true },
  { id: 'deleted_history', path: 'deleted.txt', detect: true, deleted: true },
  { id: 'placeholders', path: 'placeholders.txt', detect: false }
])

// Return only fixed identifiers/counts. Never propagate scanner output, matches,
// repository metadata or even a report containing an unredacted secret.
export function classifyGitleaksProbeResult(testCase, status, report) {
  if (!GITLEAKS_POLICY_CASES.includes(testCase)) {
    throw new Error('invalid_probe_case')
  }
  if (!Array.isArray(report) || ![0, 23].includes(status)) {
    return { case: testCase.id, passed: false, outcome: 'scanner_failure', findings: null }
  }
  if (
    report.some(
      (finding) =>
        !finding ||
        typeof finding !== 'object' ||
        finding.Secret !== 'REDACTED' ||
        typeof finding.RuleID !== 'string' ||
        typeof finding.File !== 'string'
    )
  ) {
    return { case: testCase.id, passed: false, outcome: 'unsafe_report', findings: null }
  }
  const consistent = status === (report.length ? 23 : 0)
  const detected = report.some((finding) => finding.RuleID === 'private-key' && finding.File === testCase.path)
  return {
    case: testCase.id,
    passed: consistent && (testCase.detect ? detected : report.length === 0),
    outcome: !consistent ? 'scanner_failure' : detected ? 'detected' : 'not_detected',
    findings: report.length
  }
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 256 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error || result.signal) throw new Error('probe_process_failed')
  return result
}

export async function probeGitleaksPolicy({ configPath, scratchRoot, binary = 'gitleaks' }) {
  if (!isAbsolute(configPath) || !isAbsolute(scratchRoot)) throw new Error('absolute_paths_required')
  // Reading only the policy, never a real repository's files or credentials.
  const policy = await readFile(configPath, 'utf8')
  const directory = await mkdtemp(join(scratchRoot, 'neteco-gitleaks-policy-'))
  try {
    const env = {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(directory, 'no-global-config'),
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Synthetic policy probe',
      GIT_AUTHOR_EMAIL: 'probe@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic policy probe',
      GIT_COMMITTER_EMAIL: 'probe@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'
    }
    const version = run(binary, ['version'], directory, env)
    if (version.status !== 0 || version.stdout.trim().replace(/^v/, '') !== GITLEAKS_PROBE_VERSION) {
      throw new Error('pinned_gitleaks_required')
    }
    const ownedConfig = join(directory, 'policy.toml')
    await writeFile(ownedConfig, policy, { flag: 'wx', mode: 0o600 })
    // Not a key: deliberately invalid, deterministic material matching the
    // official private-key rule. Construct markers to avoid self-detection.
    const marker = ['PRIVATE', 'KEY'].join(' ')
    const canary = `-----BEGIN ${marker}-----\n${'SYNTHETIC_POLICY_CANARY_'.repeat(5)}\n-----END ${marker}-----\n`
    const cases = []
    for (const testCase of GITLEAKS_POLICY_CASES) {
      const repository = join(directory, testCase.id)
      await mkdir(repository)
      const git = (args) => {
        if (
          run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], repository, env)
            .status !== 0
        ) {
          throw new Error('fixture_git_failed')
        }
      }
      git(['init', '--quiet'])
      const target = join(repository, testCase.path)
      await mkdir(resolve(target, '..'), { recursive: true })
      await writeFile(
        target,
        testCase.detect ? canary : 'AUTH_TOKEN_PEPPER=${AUTH_TOKEN_PEPPER}\nPASSWORD=changeme\n',
        { flag: 'wx', mode: 0o600 }
      )
      if (!testCase.detect) {
        // Exercise legitimate placeholders in the same three paths whose
        // whole-file exclusions are challenged by the positive canaries.
        for (const fixtureCase of GITLEAKS_POLICY_CASES.slice(1, 4)) {
          const fixturePath = join(repository, fixtureCase.path)
          await mkdir(resolve(fixturePath, '..'), { recursive: true })
          await writeFile(fixturePath, 'AUTH_TOKEN_PEPPER=${AUTH_TOKEN_PEPPER}\nPASSWORD=changeme\n', {
            flag: 'wx',
            mode: 0o600
          })
        }
      }
      git(['add', '--all'])
      git(['commit', '--quiet', '-m', 'Synthetic fixture'])
      if (testCase.deleted) {
        git(['rm', '--quiet', '--', testCase.path])
        git(['commit', '--quiet', '-m', 'Remove synthetic fixture'])
      }
      const reportPath = join(directory, `${testCase.id}.json`)
      const result = run(
        binary,
        [
          'detect',
          '--source',
          repository,
          '--config',
          ownedConfig,
          '--no-banner',
          '--redact=100',
          '--exit-code=23',
          '--report-format=json',
          '--report-path',
          reportPath,
          '--log-level=error',
          '--log-opts=--all'
        ],
        directory,
        env
      )
      let report = null
      try {
        report = JSON.parse(await readFile(reportPath, 'utf8'))
      } catch {
        // Missing/malformed evidence is not a clean scan.
      }
      cases.push(classifyGitleaksProbeResult(testCase, result.status, report))
    }
    return { tool: 'gitleaks', version: GITLEAKS_PROBE_VERSION, passed: cases.every((item) => item.passed), cases }
  } finally {
    // Only the exact directory returned by our mkdtemp is owned.
    await rm(directory, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 3 || args[0] !== '--go') throw new Error('usage_requires_go_config_and_scratch_root')
  const result = await probeGitleaksPolicy({ configPath: args[1], scratchRoot: args[2] })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.passed) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('gitleaks_policy_probe_failed\n')
    process.exitCode = 1
  })
}
