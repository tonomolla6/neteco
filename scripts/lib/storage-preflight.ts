import { realpath, stat, statfs } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'

const MINIMUM_BYTES = 4n * 1024n ** 3n
const MINIMUM_INODES = 100000n

interface StorageStatistics {
  bsize: bigint
  blocks: bigint
  bavail: bigint
  files: bigint
  ffree: bigint
}
export interface StorageProbe {
  realpath(path: string): Promise<string>
  isDirectory(path: string): Promise<boolean>
  statfs(path: string): Promise<StorageStatistics>
}
interface StorageTarget {
  label: string
  path: string
}
interface StorageCheck {
  label: string
  pass: boolean
  code: string
  availableBytes?: string
  freeInodes?: string
  warnings: string[]
}
const filesystemProbe: StorageProbe = {
  realpath,
  isDirectory: async (path) => (await stat(path)).isDirectory(),
  statfs: (path) => statfs(path, { bigint: true })
}

/** Read-only admission, never a cleanup policy. Available blocks exclude the
 * filesystem's reserved blocks. Unknown inode capacity is not a passing check.
 * Report only caller-approved labels, counters and fixed codes, never paths or
 * provider errors. A successful check is point-in-time, not a reservation. */
export async function storagePreflight(targets: readonly StorageTarget[], probe: StorageProbe = filesystemProbe) {
  const checks: StorageCheck[] = []
  const seen = new Set<string>()
  for (const target of targets) {
    const validLabel = /^[a-z][a-z0-9_-]{0,39}$/.test(target.label)
    const check: StorageCheck = {
      label: validLabel ? target.label : 'invalid',
      pass: false,
      code: 'invalid_target',
      warnings: []
    }
    checks.push(check)
    if (!validLabel || seen.has(target.label)) continue
    seen.add(target.label)
    if (
      !isAbsolute(target.path) ||
      target.path === '/' ||
      normalize(target.path) !== target.path ||
      [...target.path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ) {
      check.code = 'invalid_path'
      continue
    }
    try {
      if ((await probe.realpath(target.path)) !== target.path) {
        check.code = 'path_alias'
        continue
      }
      if (!(await probe.isDirectory(target.path))) {
        check.code = 'not_directory'
        continue
      }
      const stats = await probe.statfs(target.path)
      if (
        ![stats.bsize, stats.blocks, stats.bavail, stats.files, stats.ffree].every(
          (value) => typeof value === 'bigint'
        ) ||
        stats.bsize <= 0n ||
        stats.blocks <= 0n ||
        stats.bavail < 0n ||
        stats.bavail > stats.blocks ||
        stats.files <= 0n ||
        stats.ffree < 0n ||
        stats.ffree > stats.files
      ) {
        check.code = 'invalid_statistics'
        continue
      }
      const availableBytes = stats.bsize * stats.bavail
      check.availableBytes = String(availableBytes)
      check.freeInodes = String(stats.ffree)
      if (availableBytes < 2n * MINIMUM_BYTES) check.warnings.push('low_byte_headroom')
      if (stats.ffree < 2n * MINIMUM_INODES) check.warnings.push('low_inode_headroom')
      check.pass = availableBytes >= MINIMUM_BYTES && stats.ffree >= MINIMUM_INODES
      check.code = check.pass ? 'ok' : 'insufficient_storage'
    } catch {
      check.code = 'storage_unavailable'
    }
  }
  return {
    pass: checks.length > 0 && checks.every((check) => check.pass),
    minimumBytes: String(MINIMUM_BYTES),
    minimumInodes: String(MINIMUM_INODES),
    checks
  }
}
