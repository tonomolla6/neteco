import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const wrapper = resolve('scripts/lib/neteco-oracle-docker.sh')

function invoke(args: string[], status: number) {
  // Override the Bash exec builtin in this process only. Source the complete
  // real wrapper; never execute the operator-installed CLI or any Docker API.
  const result = spawnSync(
    '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      `
exec() {
  printf '%s\\0' "$@"
  printf 'cli stderr marker\\n' >&2
  return "$FIXTURE_STATUS"
}
source "$FIXTURE_WRAPPER" "$@"
`,
      'wrapper-fixture',
      ...args
    ],
    {
      env: { PATH: '/usr/bin:/bin', FIXTURE_WRAPPER: wrapper, FIXTURE_STATUS: String(status) },
      encoding: 'utf8',
      timeout: 1000
    }
  )
  expect(result.error).toBeUndefined()
  return result
}

it.each([0, 17, 125])('preserves CLI argv, stdout, stderr and exit status %s', (status) => {
  const args = [
    'buildx',
    'build',
    '--builder',
    'fixture-only',
    '--tag',
    'nombre Ñ 😀',
    '',
    'line\nbreak',
    '$(not-executed)',
    '--',
    '-H'
  ]
  const result = invoke(args, status)
  expect(result.status).toBe(status)
  expect(result.stdout).toBe(
    ['/usr/local/libexec/neteco-ci/docker-cli', '--host=unix:///run/neteco-container/docker.sock', ...args].join('\0') +
      '\0'
  )
  expect(result.stderr).toBe('cli stderr marker\n')
})

it.each([[], ['--host=tcp://fixture.invalid'], ['--context', 'fixture-context'], ['-H', 'unix:///fixture']])(
  'delegates arguments unchanged rather than replacing official CLI validation %#',
  (...args) => {
    const result = invoke(args, 1)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe(
      ['/usr/local/libexec/neteco-ci/docker-cli', '--host=unix:///run/neteco-container/docker.sock', ...args].join(
        '\0'
      ) + '\0'
    )
    expect(result.stderr).toBe('cli stderr marker\n')
  }
)

it('contains no daemon lifecycle or fallback after exec', () => {
  const source = readFileSync(wrapper, 'utf8')
  const commands = source.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'))
  expect(commands).toHaveLength(1)
  expect(commands[0]).toMatch(/^exec /)
})
