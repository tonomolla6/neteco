import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const hook = resolve('scripts/lib/neteco-oracle-job-started.sh')
const approvedJob = {
  GITHUB_REPOSITORY: 'tonomolla6/neteco',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
  RUNNER_NAME: 'neteco-oracle-arm64-01',
  GITHUB_WORKSPACE: '/var/lib/neteco-ci/runner/_work/neteco/neteco',
  RUNNER_TEMP: '/var/lib/neteco-ci/runner/_work/_temp'
}

describe('Oracle checkout hook copy never admits jobs (real Bash)', () => {
  // CI may have a real operator-approved marker. Never inspect/mutate it or
  // assume its absence: this checkout copy must stop before admission anyway.
  const checkoutDenial = /^neteco-oracle-job: denied: (jobs_not_approved|untrusted_operator_path|untrusted_hook)$/
  it.each([
    {},
    { GITHUB_REPOSITORY: 'PublicHer0/neteco-shop' },
    { GITHUB_REPOSITORY: 'other/neteco' },
    { GITHUB_REF: 'refs/heads/untrusted' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'schedule' },
    { RUNNER_NAME: 'another-runner' },
    { RUNNER_TEMP: '/tmp' },
    { NETECO_SKIP_PREFLIGHT: 'true', NETECO_JOBS_APPROVED: 'true', DOCKER_HOST: 'unix:///var/run/docker.sock' }
  ])('rejects the checkout copy regardless of job environment %j', (overrides) => {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', hook], {
      env: { PATH: '/usr/bin:/bin', ...approvedJob, ...overrides },
      encoding: 'utf8',
      timeout: 1000
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim()).toMatch(checkoutDenial)
  })

  it('cannot admit the checkout copy through command-line flags', () => {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', hook, '--approve', '--skip-preflight'], {
      env: { PATH: '/usr/bin:/bin', ...approvedJob },
      encoding: 'utf8',
      timeout: 1000
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim()).toMatch(checkoutDenial)
  })
})

describe('private Docker endpoint (real hook function and own UNIX socket; simulated operator metadata)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'neteco-hook-socket-owned-'))
  const socket = join(directory, 'docker.sock')
  const executable = join(directory, 'operator-executable')
  let server: ChildProcessWithoutNullStreams
  let serverExit: Promise<number | null>
  beforeAll(async () => {
    writeFileSync(executable, '', { mode: 0o700 })
    server = spawn('/usr/bin/python3', [
      '-c',
      "import socket, sys\ns = socket.socket(socket.AF_UNIX)\ns.bind(sys.argv[1])\ns.listen(1)\nprint('ready', flush=True)\nsys.stdin.read()\ns.close()",
      socket
    ])
    serverExit = new Promise((done) => {
      server.once('error', () => done(null))
      server.once('exit', (code) => done(code))
    })
    await new Promise<void>((done, reject) => {
      server.once('error', reject)
      server.once('exit', (code) => reject(new Error(`Unix socket fixture exited before readiness: ${code}`)))
      server.stdout.once('data', () => done())
    })
    symlinkSync(socket, join(directory, 'socket-link'))
    symlinkSync(directory, join(directory, 'directory-link'))
  })
  afterAll(async () => {
    try {
      if (server.exitCode === null && server.signalCode === null && !server.stdin.destroyed) server.stdin.end()
      expect(await serverExit).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function verify(overrides: Record<string, string | undefined> = {}) {
    expect(server.exitCode).toBeNull()
    expect(server.signalCode).toBeNull()
    const source = readFileSync(hook, 'utf8')
    const definition = source.match(/^verify_private_docker\(\) \{\n[\s\S]*?^\}/m)?.[0]
    expect(definition).toBeDefined()
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-s'], {
      env: {
        PATH: '/usr/bin:/bin',
        DOCKER_HOST: 'unix:///run/neteco-container/docker.sock',
        DOCKER_CONTEXT: '',
        FIXTURE_DIRECTORY: directory,
        FIXTURE_SOCKET: socket,
        FIXTURE_EXECUTABLE: executable,
        DIRECTORY_METADATA: '11080 11080 750',
        SOCKET_METADATA: '11080 11080 660',
        ...overrides
      },
      input: `set -euo pipefail
deny() { printf 'denied:%s\\n' "$1" >&2; exit 1; }
root_managed() {
  case "$1" in
    /usr/local/libexec/neteco-ci/bin/docker|/usr/local/libexec/neteco-ci/docker-cli|/run) : ;;
    *) deny unexpected_path ;;
  esac
  [[ "\${UNTRUSTED_PATH:-}" != "$1" ]] || deny untrusted_operator_path
}
function /usr/bin/test() {
  local -a operands=("$@")
  case "\${operands[-1]}" in
    /run/neteco-container) operands[-1]="$FIXTURE_DIRECTORY" ;;
    /run/neteco-container/docker.sock) operands[-1]="$FIXTURE_SOCKET" ;;
    /usr/local/libexec/neteco-ci/bin/docker|/usr/local/libexec/neteco-ci/docker-cli) operands[-1]="$FIXTURE_EXECUTABLE" ;;
    *) deny unexpected_path ;;
  esac
  builtin test "\${operands[@]}"
}
function /usr/bin/stat() {
  [[ $# == 4 && "$1" == -c && "$2" == '%u %g %a' && "$3" == -- ]] || deny unexpected_stat
  case "$4" in
    /run/neteco-container) printf '%s\\n' "$DIRECTORY_METADATA" ;;
    /run/neteco-container/docker.sock) printf '%s\\n' "$SOCKET_METADATA" ;;
    *) deny unexpected_path ;;
  esac
}
${definition}
verify_private_docker
printf 'harness_endpoint_verified\\n'
`,
      encoding: 'utf8',
      timeout: 1000
    })
    expect(result.error).toBeUndefined()
    return result
  }

  it.each([
    { DOCKER_HOST: undefined },
    { DOCKER_HOST: '' },
    { DOCKER_HOST: 'unix:///var/run/docker.sock' },
    { DOCKER_HOST: 'tcp://sensitive.invalid:2375' },
    { DOCKER_CONTEXT: 'remote' }
  ])('rejects nonfixed endpoint/context %# without inspecting the private socket', (overrides) => {
    const result = verify(overrides)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('denied:docker_override\n')
  })

  it.each([
    { DIRECTORY_METADATA: '980 11080 750' },
    { DIRECTORY_METADATA: '11080 980 750' },
    { DIRECTORY_METADATA: '11080 11080 770' },
    { SOCKET_METADATA: '0 11080 660' },
    { SOCKET_METADATA: '11080 0 660' },
    { SOCKET_METADATA: '11080 11080 666' }
  ])('rejects untrusted directory/socket metadata %#', (overrides) => {
    const result = verify(overrides)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('denied:private_docker_socket\n')
  })

  it('requires a real socket rather than a regular file', () => {
    expect(verify({ FIXTURE_SOCKET: executable }).stderr).toBe('denied:private_docker_socket\n')
  })

  it.each(['socket', 'directory'])('rejects a symlinked %s using real own filesystem predicates', (kind) => {
    const result = verify(
      kind === 'socket'
        ? { FIXTURE_SOCKET: join(directory, 'socket-link') }
        : { FIXTURE_DIRECTORY: join(directory, 'directory-link') }
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('denied:private_docker_socket\n')
  })

  it('rejects a missing socket', () => {
    const result = verify({ FIXTURE_SOCKET: join(directory, 'missing.sock') })
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('denied:private_docker_socket\n')
  })

  it.each(['/usr/local/libexec/neteco-ci/bin/docker', '/usr/local/libexec/neteco-ci/docker-cli'])(
    'checks root-managed %s before accepting even a bad environment',
    (path) => {
      const result = verify({ UNTRUSTED_PATH: path, DOCKER_HOST: 'tcp://invalid' })
      expect(result.status).toBe(1)
      expect(result.stderr).toBe('denied:untrusted_operator_path\n')
    }
  )

  it('accepts only the fixed endpoint and simulated exact metadata, without calling a daemon', () => {
    const result = verify()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('harness_endpoint_verified\n')
    expect(result.stderr).toBe('')
    const source = readFileSync(hook, 'utf8')
    const call = source.indexOf('\nverify_private_docker\n')
    expect(call).toBeGreaterThan(source.indexOf('|| deny context'))
    expect(call).toBeLessThan(source.lastIndexOf("printf 'neteco-oracle-job: approved"))
  })
})

describe('installed build-storage invocation (real hook function, isolated Bash doubles)', () => {
  function runGate(present: boolean, exitCode: number) {
    const source = readFileSync(hook, 'utf8')
    const definition = source.match(/^verify_build_storage\(\) \{\n[\s\S]*?^\}/m)?.[0]
    expect(definition).toBeDefined()
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-s'], {
      env: { PATH: '/usr/bin:/bin' },
      input: `set -euo pipefail
deny() { printf 'denied:%s\\n' "$1" >&2; exit 1; }
gate_trusted=0
node_trusted=0
gate_invocations=0
# Resource behavior is exercised separately with the real helper below.
verify_job_resources() { :; }
root_managed() {
  case "$1" in
    /usr/local/libexec/neteco-ci/build-storage.mjs) ${present ? 'gate_trusted=1' : 'deny untrusted_operator_path'} ;;
    /opt/devtono/toolchains/node-v24.18.1-linux-arm64/bin/node) node_trusted=1 ;;
    *) deny unexpected_path ;;
  esac
}
function /opt/devtono/toolchains/node-v24.18.1-linux-arm64/bin/node() {
  [[ "$gate_trusted" == 1 && "$node_trusted" == 1 ]] || deny invocation_before_trust
  [[ $# == 3 && "$1" == /usr/local/libexec/neteco-ci/build-storage.mjs && "$2" == --estimated-output-gib && "$3" == 2 ]] || deny unexpected_arguments
  ((gate_invocations+=1))
  return ${exitCode}
}
${definition}
verify_build_storage
[[ "$gate_invocations" == 1 ]] || deny gate_not_invoked
printf 'harness_gate_passed\\n'
`,
      encoding: 'utf8',
      timeout: 1000
    })
    expect(result.error).toBeUndefined()
    return result
  }

  it('rejects a missing or untrusted installed gate before invoking Node', () => {
    const result = runGate(false, 0)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('denied:untrusted_operator_path\n')
  })

  it('rejects a failing gate instead of continuing to approval', () => {
    const result = runGate(true, 17)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('denied:build_storage_failed\n')
  })

  it('uses the fixed Node, gate and estimate without passing CLI/environment-selected paths', () => {
    const result = runGate(true, 0)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('harness_gate_passed\n')
    expect(result.stderr).toBe('')
    const source = readFileSync(hook, 'utf8')
    const call = source.indexOf('\nverify_build_storage\n')
    expect(call).toBeGreaterThan(source.indexOf('|| deny context'))
    expect(call).toBeLessThan(source.lastIndexOf("printf 'neteco-oracle-job: approved"))
  })
})

describe('pre-checkout resource admission (real hook functions, isolated measurements)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'neteco-hook-memory-view-owned-'))
  const view = join(directory, 'meminfo')
  beforeAll(() => writeFileSync(view, 'synthetic measured memory view\n', { mode: 0o400 }))
  afterAll(() => rmSync(directory, { recursive: true, force: true }))
  function admission(overrides: Record<string, string> = {}) {
    const source = readFileSync(hook, 'utf8')
    const storage = source.match(/^verify_build_storage\(\) \{\n[\s\S]*?^\}/m)![0]
    const resources = source.match(/^verify_job_resources\(\) \{\n[\s\S]*?^\}/m)?.[0] ?? ''
    return spawnSync('/bin/bash', ['--noprofile', '--norc', '-s'], {
      env: {
        PATH: '/usr/bin:/bin',
        MEMORY: '10485760 kB',
        CURRENT: '100000000',
        MAXIMUM: '10737418240',
        SWAP: '0',
        SWAP_MAX: '536870912',
        ANCESTOR_MAX: 'max',
        FIXTURE_VIEW: view,
        VIEW_TRUSTED: '1',
        ...overrides
      },
      input: `set -euo pipefail
deny() { printf 'denied:%s\\n' "$1" >&2; exit 1; }
root_managed() {
  case "$1" in
    /run/neteco-ci-resources/meminfo)
      [[ "$VIEW_TRUSTED" == 1 && -e "$FIXTURE_VIEW" && ! -L "$FIXTURE_VIEW" ]] || deny untrusted_operator_path ;;
    /usr/local/libexec/neteco-ci/build-storage.mjs|/opt/devtono/toolchains/node-v24.18.1-linux-arm64/bin/node) : ;;
    *) deny unexpected_path ;;
  esac
}
function /usr/bin/test() {
  local -a args=("$@")
  [[ "\${args[-1]}" == /run/neteco-ci-resources/meminfo ]] || deny unexpected_path
  args[-1]="$FIXTURE_VIEW"
  builtin test "\${args[@]}"
}
function /usr/bin/awk() {
  [[ $# == 2 && "$2" == /run/neteco-ci-resources/meminfo ]] || deny legacy_meminfo
  [[ "$VIEW_TRUSTED" == 1 ]] || deny measurement_before_trust
  printf '%s\\n' "$MEMORY"
}
function /usr/bin/cat() {
  case "$2" in
    /proc/self/cgroup) printf '%s\\n' "\${CGROUP:-0::/system.slice/neteco.service}" ;;
    /sys/fs/cgroup/system.slice/neteco.service/memory.current) printf '%s\\n' "$CURRENT" ;;
    /sys/fs/cgroup/system.slice/neteco.service/memory.max) printf '%s\\n' "$MAXIMUM" ;;
    /sys/fs/cgroup/system.slice/neteco.service/memory.swap.current) printf '%s\\n' "$SWAP" ;;
    /sys/fs/cgroup/system.slice/neteco.service/memory.swap.max) printf '%s\\n' "$SWAP_MAX" ;;
    /sys/fs/cgroup/system.slice/memory.current) printf '200000000\\n' ;;
    /sys/fs/cgroup/system.slice/memory.max) printf '%s\\n' "$ANCESTOR_MAX" ;;
    /sys/fs/cgroup/system.slice/memory.swap.current) printf '0\\n' ;;
    /sys/fs/cgroup/system.slice/memory.swap.max) printf 'max\\n' ;;
    *) return 1 ;;
  esac
}
function /opt/devtono/toolchains/node-v24.18.1-linux-arm64/bin/node() { printf 'storage_called\\n'; }
${resources}
${storage}
verify_build_storage
printf 'admitted\\n'
`,
      encoding: 'utf8',
      timeout: 1000
    })
  }
  it.each([
    ['host RAM at the reserve boundary despite ample swap', { MEMORY: '8388608 kB', SWAP_MAX: 'max' }],
    ['current runner limit below the additional build peak', { MAXIMUM: '3221225472' }],
    ['a restrictive ancestor despite an unlimited leaf', { MAXIMUM: 'max', ANCESTOR_MAX: '4294967296' }],
    ['malformed host measurement', { MEMORY: 'unknown' }],
    ['malformed memory limit', { MAXIMUM: 'not-a-limit' }],
    ['used swap beyond its finite limit', { SWAP: '536870913' }],
    ['malformed swap measurement', { SWAP: 'unknown' }],
    ['malformed cgroup with shell syntax', { CGROUP: '0::/system.slice/$(touch forbidden)' }]
  ] as const)('rejects %s before running the storage gate or admitting checkout', (_label, overrides) => {
    const result = admission(overrides)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^denied:job_resources_(?:unknown|memory|cgroup|swap)\n$/)
  })
  it.each([
    { MAXIMUM: 'max', SWAP_MAX: 'max' },
    { MAXIMUM: '4394967296', ANCESTOR_MAX: '4494967296' }
  ])('accepts measured finite/unlimited headroom without changing limits %j', (overrides) => {
    const result = admission(overrides)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('storage_called\nadmitted\n')
    expect(result.stderr).toBe('')
  })
  it.each([
    ['absent', { FIXTURE_VIEW: join(directory, 'missing') }, 'untrusted_operator_path'],
    ['untrusted', { VIEW_TRUSTED: '0' }, 'untrusted_operator_path'],
    ['non-regular', { FIXTURE_VIEW: directory }, 'job_resources_unknown']
  ] as const)('rejects an %s operator memory view without legacy reads or gate calls', (_label, overrides, code) => {
    const result = admission(overrides)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`denied:${code}\n`)
  })
})
