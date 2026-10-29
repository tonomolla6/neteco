#!/usr/bin/env node
// Operator acceptance in the real isolated runner unit, never an Actions job.
// Only public pinned images, generated names/labels and synthetic data are used.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'

assert.equal(process.argv.length, 2)
assert.equal(process.getuid(), 980)
assert.equal(process.getgid(), 979)
assert.equal(process.env.DOCKER_HOST, 'unix:///run/neteco-container/docker.sock')
assert.equal(readFileSync('/proc/self/cgroup', 'utf8').trim(), '0::/system.slice/devtono-neteco-actions-runner.service')
const cli = '/usr/local/libexec/neteco-ci/bin/docker'
const node = '/opt/devtono/toolchains/node-v24.18.1-linux-arm64/bin/node'
const probeId = randomUUID()
const label = `neteco.operator.acceptance=${probeId}`
const owned = new Set()
const probeErrors = []
const cleanupErrors = []
const workspace = join('/var/lib/neteco-ci/runner/_work', `container-acceptance-${probeId}`)
const command = (args, timeout = 30000) =>
  execFileSync(cli, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }).trim()
const budget = () =>
  execFileSync(node, ['/usr/local/libexec/neteco-ci/build-storage.mjs', '--estimated-output-gib', '2'], {
    stdio: 'inherit',
    timeout: 10000
  })
const inspect = (id) => JSON.parse(command(['inspect', id]))[0]
function create(args) {
  const id = command([
    'create',
    '--label',
    label,
    '--cpus',
    '0.5',
    '--memory',
    '256m',
    '--memory-swap',
    '384m',
    '--pids-limit',
    '128',
    ...args
  ])
  assert.match(id, /^[a-f0-9]{64}$/)
  owned.add(id)
  // Record ownership before start: a runtime/cgroup failure must not leave an
  // untracked created container behind.
  command(['start', id])
  return id
}
async function waitReady(id, args) {
  let lastError
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return command(['exec', id, ...args], 5000)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw lastError
}
async function tcp(port, input, expected) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const chunks = []
    const timer = setTimeout(() => socket.destroy(new Error('Private service TCP timeout')), 5000)
    socket.once('connect', () => socket.write(input))
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const received = Buffer.concat(chunks)
      if (received.length >= expected.length) {
        try {
          assert.deepEqual(received.subarray(0, expected.length), expected)
          socket.destroy()
          resolve()
        } catch (error) {
          socket.destroy()
          reject(error)
        }
      }
    })
    socket.once('error', reject)
    socket.once('close', () => {
      clearTimeout(timer)
      reject(new Error('Private service closed before its expected response'))
    })
  })
}
function port(id, key) {
  const data = inspect(id)
  assert.equal(data.Config.Labels['neteco.operator.acceptance'], probeId)
  assert.equal(data.HostConfig.Memory, 256 * 1024 * 1024)
  assert.equal(data.HostConfig.PidsLimit, 128)
  assert.equal(data.HostConfig.NanoCpus, 500000000)
  const binding = data.NetworkSettings.Ports[key]
  assert.equal(binding.length, 1)
  assert.equal(binding[0].HostIp, '127.0.0.1')
  return Number(binding[0].HostPort)
}
function kernelResources(id) {
  assert.equal(inspect(id).HostConfig.Runtime, 'crun')
  // Read the mounted cgroup v2 kernel files, not just the requested Docker
  // HostConfig. Missing files, unlimited values or ignored limits fail closed.
  const values = command([
    'exec',
    id,
    'sh',
    '-c',
    'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max'
  ]).split('\n')
  assert.equal(values.length, 4)
  assert.equal(values[0], String(256 * 1024 * 1024))
  assert.equal(values[1], String(128 * 1024 * 1024))
  assert.equal(values[2], '128')
  const cpu = values[3].split(' ').map(Number)
  assert.equal(cpu.length, 2)
  assert(cpu.every((value) => Number.isSafeInteger(value) && value > 0))
  assert.equal(cpu[0] / cpu[1], 0.5)
}
try {
  budget()
  for (const image of ['postgres:17.6-alpine3.22', 'redis:8.2.1-alpine3.22']) {
    command(['pull', image], 180000)
    budget()
  }
  const pg = create([
    '--name',
    `neteco-probe-pg-${probeId}`,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_USER=neteco',
    '--env',
    'POSTGRES_PASSWORD=neteco-test',
    '--env',
    'POSTGRES_DB=neteco_test',
    'postgres:17.6-alpine3.22'
  ])
  const redis = create([
    '--name',
    `neteco-probe-redis-${probeId}`,
    '--publish',
    '127.0.0.1::6379',
    'redis:8.2.1-alpine3.22'
  ])
  await waitReady(pg, ['pg_isready', '-U', 'neteco', '-d', 'neteco_test'])
  assert.equal(await waitReady(redis, ['redis-cli', 'ping']), 'PONG')
  kernelResources(pg)
  kernelResources(redis)
  assert.equal(
    command([
      'exec',
      pg,
      'psql',
      '-U',
      'neteco',
      '-d',
      'neteco_test',
      '-At',
      '-c',
      'CREATE TABLE acceptance (value integer); INSERT INTO acceptance VALUES (42); SELECT value FROM acceptance;'
    ])
      .split('\n')
      .at(-1),
    '42'
  )
  assert.equal(command(['exec', redis, 'redis-cli', 'set', 'neteco:acceptance', 'synthetic']), 'OK')
  assert.equal(command(['exec', redis, 'redis-cli', 'get', 'neteco:acceptance']), 'synthetic')
  await tcp(port(redis, '6379/tcp'), Buffer.from('*1\r\n$4\r\nPING\r\n'), Buffer.from('+PONG\r\n'))
  // PostgreSQL SSL negotiation proves the runner reaches that published server;
  // its actual SQL read/write is separately checked above using psql.
  await tcp(port(pg, '5432/tcp'), Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]), Buffer.from('N'))
  mkdirSync(workspace, { mode: 0o700 })
  const mount = create([
    '--name',
    `neteco-probe-bind-${probeId}`,
    '--mount',
    `type=bind,src=${workspace},dst=/workspace`,
    '--entrypoint',
    'sh',
    'redis:8.2.1-alpine3.22',
    '-c',
    'printf synthetic-idmap > /workspace/proof; sleep 30'
  ])
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      assert.equal(readFileSync(join(workspace, 'proof'), 'utf8'), 'synthetic-idmap')
      break
    } catch (error) {
      if (attempt === 29) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  assert.equal(statSync(join(workspace, 'proof')).uid, 980)
  assert.equal(inspect(mount).Config.Labels['neteco.operator.acceptance'], probeId)
  console.log(
    JSON.stringify({
      acceptance: 'private-container-services',
      status: 'passed',
      postgres: '17.6',
      redis: '8.2.1',
      runnerTcp: true,
      resources: 'kernel_cgroup_v2_readback',
      runtime: 'crun',
      idmappedWriteUid: 980,
      probeId
    })
  )
} catch (error) {
  probeErrors.push(error)
} finally {
  try {
    // Also recover a create that committed but lost its CLI response. The UUID
    // label is exclusive to this invocation; never discover by a name prefix.
    for (const id of command(['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${label}`]).split('\n')) {
      if (!id) continue
      assert.match(id, /^[a-f0-9]{64}$/)
      owned.add(id)
    }
  } catch (error) {
    cleanupErrors.push(error)
  }
  for (const id of owned) {
    try {
      assert.equal(inspect(id).Config.Labels['neteco.operator.acceptance'], probeId)
      command(['rm', '--force', '--volumes', id])
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  console.log(
    JSON.stringify({
      cleanup: 'only-owned-labelled-containers',
      count: owned.size,
      failures: cleanupErrors.length,
      probeId,
      retainedSyntheticWorkspace: workspace
    })
  )
}
if (probeErrors.length || cleanupErrors.length)
  throw new AggregateError([...probeErrors, ...cleanupErrors], 'Private container service acceptance failed')
