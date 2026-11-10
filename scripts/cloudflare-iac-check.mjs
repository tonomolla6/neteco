import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const TOOLCHAIN = '/usr/local/libexec/neteco-ci/iac'
const TOFU = `${TOOLCHAIN}/tofu`
const MIRROR = `${TOOLCHAIN}/mirror`
const PROVIDER = `${MIRROR}/registry.opentofu.org/cloudflare/cloudflare/5.25.0/linux_arm64/terraform-provider-cloudflare_v5.25.0`
const FILES = ['edge.tf', 'outputs.tf', 'resources.tf', 'variables.tf', 'versions.tf']
const GiB = 1024 ** 3
const digest = (value) => createHash('sha256').update(value).digest('hex')

// These are upstream release archive hashes, not hashes generated from the
// current checkout. An operator must verify/extract them and seal the manifest
// and binaries before this gate can run. This script never installs anything.
export const PINNED_ARCHIVES = Object.freeze({
  tofu: 'a32f653d686a8cad9b9be82101eb5b5e834fbfa8d095842fa1820c5d27fad967',
  cloudflare: 'c47e38911c92e0b2ffe7be1d36d96b79dd2af79bc61745d6afe5a730cae9f287'
})

export function verifyToolchainManifest(manifest, binaries) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.tofuVersion !== '1.10.6' ||
    manifest.providerVersion !== '5.25.0' ||
    manifest.platform !== 'linux_arm64'
  )
    throw new Error('toolchain_version')
  for (const name of ['tofu', 'cloudflare']) {
    if (
      manifest[name]?.archiveSha256 !== PINNED_ARCHIVES[name] ||
      !/^[a-f0-9]{64}$/.test(manifest[name]?.binarySha256 ?? '') ||
      digest(binaries[name]) !== manifest[name].binarySha256
    )
      throw new Error('toolchain_hash')
  }
}

async function sealed(path, directory = false) {
  if ((await realpath(path)) !== path) throw new Error('toolchain_not_sealed')
  let cursor = path
  while (true) {
    const metadata = await lstat(cursor)
    if (metadata.uid !== 0 || metadata.gid !== 0 || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0)
      throw new Error('toolchain_not_sealed')
    if (cursor === path && (directory ? !metadata.isDirectory() : !metadata.isFile()))
      throw new Error('toolchain_not_sealed')
    if (cursor === '/') break
    cursor = dirname(cursor)
  }
}

export async function assertCgroupMemoryBudget(group, read = (path) => readFile(path, 'utf8')) {
  const leaf = join('/sys/fs/cgroup', group)
  // The job's own cgroup must not be swapping. Shared ancestors (system.slice)
  // also hold other host services' swap, which says nothing about this job.
  if (Number(await read(join(leaf, 'memory.swap.current'))) !== 0) throw new Error('cgroup_swap_in_use')
  let cursor = leaf
  // The cgroup-v2 root has no memory.max controller limit; its host budget
  // was checked by the caller. Every non-root ancestor must admit this peak.
  while (cursor !== '/sys/fs/cgroup') {
    const current = Number(await read(join(cursor, 'memory.current')))
    const maximum = (await read(join(cursor, 'memory.max'))).trim()
    if (maximum !== 'max' && Number(maximum) - current < GiB) throw new Error('cgroup_memory_budget')
    cursor = dirname(cursor)
  }
}

async function resources() {
  // The runner exposes host memory read-only; its /proc view alone is not the
  // host budget. Missing isolation/admission tooling is a hard failure.
  const memory = await readFile('/run/neteco-ci-resources/meminfo', 'utf8')
  const available = Number(memory.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]) * 1024
  if (!(available > 5 * GiB)) throw new Error('host_memory_budget')
  const membership = await readFile('/proc/self/cgroup', 'utf8')
  const group = membership.match(/^0::(\/[^\n]*)$/m)?.[1]
  if (!group || group.includes('..')) throw new Error('cgroup_unavailable')
  await assertCgroupMemoryBudget(group)
  const gate = '/usr/local/libexec/neteco-ci/build-storage.mjs'
  await sealed(gate)
  await execute(process.execPath, [gate, '--estimated-output-gib', '1'], {
    env: { PATH: '/usr/bin:/bin' },
    timeout: 30000,
    maxBuffer: 16384
  })
}

async function toolchain() {
  if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('toolchain_platform')
  await sealed(TOOLCHAIN, true)
  await sealed(`${TOOLCHAIN}/manifest.json`)
  await sealed(TOFU)
  await sealed(PROVIDER)
  await sealed('/usr/bin/unshare')
  const manifestBytes = await readFile(`${TOOLCHAIN}/manifest.json`)
  if (manifestBytes.length > 4096) throw new Error('toolchain_manifest')
  const tofu = await readFile(TOFU)
  const cloudflare = await readFile(PROVIDER)
  if (tofu.length > 112 * 1024 ** 2 || cloudflare.length > 256 * 1024 ** 2) throw new Error('toolchain_size')
  verifyToolchainManifest(JSON.parse(manifestBytes.toString('utf8')), { tofu, cloudflare })
}

async function prepare() {
  const base = process.env.RUNNER_TEMP || tmpdir()
  const space = await statfs(base)
  if (space.bavail * space.bsize - 128 * 1024 ** 2 < Math.max(GiB, space.blocks * space.bsize * 0.1))
    throw new Error('temporary_disk_budget')
  const temporary = await mkdtemp(join(base, 'neteco-iac-'))
  try {
    const source = resolve('infra/cloudflare')
    const names = (await readdir(source)).filter((name) => name.endsWith('.tf') || name.endsWith('.tf.json')).sort()
    if (JSON.stringify(names) !== JSON.stringify(FILES)) throw new Error('unexpected_iac_files')
    const hashes = []
    for (const name of FILES) {
      const path = join(source, name)
      if (!(await lstat(path)).isFile()) throw new Error('invalid_iac_file')
      const bytes = await readFile(path)
      if (bytes.length > 65536) throw new Error('iac_file_size')
      hashes.push(digest(bytes))
      await writeFile(join(temporary, name), bytes, { mode: 0o600, flag: 'wx' })
    }
    const config = join(temporary, 'cli.tfrc')
    await writeFile(
      config,
      `disable_checkpoint = true\nprovider_installation {\n filesystem_mirror { path = "${MIRROR}" }\n}\n`,
      { mode: 0o600, flag: 'wx' }
    )
    return {
      temporary,
      env: {
        PATH: '/usr/bin:/bin',
        TF_CLI_CONFIG_FILE: config,
        TF_DATA_DIR: join(temporary, '.data'),
        TF_IN_AUTOMATION: '1',
        TF_INPUT: '0',
        CHECKPOINT_DISABLE: '1',
        GOMAXPROCS: '1',
        GOMEMLIMIT: '768MiB',
        TMPDIR: temporary
      },
      async unchanged() {
        for (let index = 0; index < FILES.length; index++) {
          if (digest(await readFile(join(source, FILES[index]))) !== hashes[index]) throw new Error('source_changed')
        }
      }
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function command(context, args) {
  // A new user namespace owns a new empty network namespace. No CAP_SYS_ADMIN
  // from the host is requested. If kernel/runner policy denies this, fail closed
  // rather than executing OpenTofu/provider with the runner's public egress.
  return execute(
    '/usr/bin/unshare',
    ['--user', '--map-root-user', '--net', '--', TOFU, `-chdir=${context.temporary}`, ...args],
    {
      env: context.env,
      timeout: 60000,
      maxBuffer: 1024 * 1024
    }
  )
}

// Dependencies are an explicit unit-test seam, never read from environment or
// command-line switches. CLI always uses the sealed production implementations.
export async function runOfflineIacCheck(dependencies = {}) {
  const admission = dependencies.admission ?? resources
  const verify = dependencies.verify ?? toolchain
  const create = dependencies.prepare ?? prepare
  const run = dependencies.command ?? command
  const cleanup = dependencies.cleanup ?? ((path) => rm(path, { recursive: true, force: true }))
  await admission()
  await verify()
  const context = await create()
  try {
    const version = JSON.parse((await run(context, ['version', '-json'])).stdout)
    if (version.terraform_version !== '1.10.6') throw new Error('toolchain_version')
    await run(context, ['fmt', '-check', '-diff', '-no-color'])
    await run(context, ['init', '-backend=false', '-get=false', '-input=false', '-no-color', `-plugin-dir=${MIRROR}`])
    const validation = JSON.parse((await run(context, ['validate', '-json'])).stdout)
    if (validation.valid !== true || validation.error_count !== 0 || validation.warning_count !== 0)
      throw new Error('iac_validation')
    await context.unchanged()
    return { status: 'passed', offline: true, tofuVersion: '1.10.6', providerVersion: '5.25.0', files: FILES.length }
  } finally {
    await cleanup(context.temporary)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOfflineIacCheck()
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      // Do not echo provider diagnostics/config/environment which might contain
      // future sensitive values. Failure never produces a successful artifact.
      console.error(
        'Cloudflare offline IaC gate failed; verify sealed toolchain, resource admission and user/network namespace support.'
      )
      process.exitCode = 1
    })
}
