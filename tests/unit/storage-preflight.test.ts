import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { storagePreflight, type StorageProbe } from '../../scripts/lib/storage-preflight'

const GiB = 1024n ** 3n
const healthy = () => ({ bsize: 4096n, blocks: 8n * GiB, bavail: (3n * GiB) / 1024n, files: 1000000n, ffree: 300000n })
const target = { label: 'workspace', path: '/fixture/workspace' }
function probe(overrides: Partial<StorageProbe> = {}): StorageProbe {
  return {
    realpath: async (path) => path,
    isDirectory: async () => true,
    statfs: async () => healthy(),
    ...overrides
  }
}

describe('read-only build storage preflight', () => {
  it('checks every destination with available blocks and exact bigint arithmetic', async () => {
    const calls: string[] = []
    const result = await storagePreflight(
      [target, { label: 'temporary', path: '/fixture/tmp' }],
      probe({
        statfs: async (path) => {
          calls.push(path)
          return healthy()
        }
      })
    )
    expect(calls).toEqual(['/fixture/workspace', '/fixture/tmp'])
    expect(result).toMatchObject({ pass: true, minimumBytes: String(4n * GiB), minimumInodes: '100000' })
    expect(result.checks).toHaveLength(2)
    expect(result.checks[0]).toMatchObject({ availableBytes: String(12n * GiB), freeInodes: '300000', warnings: [] })
    expect(JSON.stringify(result)).not.toContain('/fixture')
  })

  it.each([
    [4n * GiB, 100000n, true],
    [4n * GiB - 1n, 100000n, false],
    [4n * GiB, 99999n, false]
  ])('enforces exact boundaries at %s bytes and %s inodes', async (bytes, inodes, pass) => {
    const result = await storagePreflight(
      [target],
      probe({ statfs: async () => ({ ...healthy(), bsize: 1n, bavail: bytes, ffree: inodes }) })
    )
    expect(result.pass).toBe(pass)
    expect(result.checks[0]?.pass).toBe(pass)
  })

  it('reports low headroom without allowing a below-minimum filesystem', async () => {
    const result = await storagePreflight(
      [target],
      probe({ statfs: async () => ({ ...healthy(), bsize: 1n, bavail: 4n * GiB, ffree: 100000n }) })
    )
    expect(result.pass).toBe(true)
    expect(result.checks[0]?.warnings).toEqual(['low_byte_headroom', 'low_inode_headroom'])
  })

  it.each(['relative', '/', '/fixture/../workspace', '/fixture/\u0000private'])(
    'rejects unsafe path %s before filesystem access',
    async (path) => {
      const result = await storagePreflight(
        [{ ...target, path }],
        probe({
          realpath: async () => {
            throw new Error('must not probe')
          }
        })
      )
      expect(result).toMatchObject({ pass: false, checks: [{ code: 'invalid_path' }] })
    }
  )

  it('rejects aliases and files, and fails closed when any destination fails', async () => {
    expect(await storagePreflight([target], probe({ realpath: async () => '/other' }))).toMatchObject({
      pass: false,
      checks: [{ code: 'path_alias' }]
    })
    expect(await storagePreflight([target], probe({ isDirectory: async () => false }))).toMatchObject({
      pass: false,
      checks: [{ code: 'not_directory' }]
    })
    const result = await storagePreflight(
      [target, { label: 'temporary', path: '/fixture/tmp' }],
      probe({
        statfs: async (path) => {
          if (path.endsWith('/tmp')) throw new Error('secret path and provider details')
          return healthy()
        }
      })
    )
    expect(result.pass).toBe(false)
    expect(result.checks[1]?.code).toBe('storage_unavailable')
    expect(JSON.stringify(result)).not.toMatch(/secret|provider|\/fixture/)
  })

  it.each([{ bsize: 0n }, { bavail: -1n }, { bavail: 40n * GiB }, { files: 0n }, { ffree: -1n }, { ffree: 1000001n }])(
    'fails closed for invalid or unavailable filesystem statistics %s',
    async (invalid) => {
      expect(
        await storagePreflight([target], probe({ statfs: async () => ({ ...healthy(), ...invalid }) }))
      ).toMatchObject({ pass: false, checks: [{ code: 'invalid_statistics' }] })
    }
  )

  it('fails closed for empty destinations or invalid/duplicate labels without exposing them', async () => {
    expect((await storagePreflight([], probe())).pass).toBe(false)
    for (const targets of [[{ ...target, label: '/private/secret' }], [target, target]]) {
      const result = await storagePreflight(targets, probe())
      expect(result.pass).toBe(false)
      expect(JSON.stringify(result)).not.toContain('/private/secret')
    }
  })

  it('CLI rejects unsupported arguments with structured JSON and no supplied path leak', async () => {
    const run = promisify(execFile)
    const result = await run(
      process.execPath,
      ['--import', 'tsx', 'scripts/storage-preflight.ts', '--cleanup=/private/secret'],
      { cwd: process.cwd() }
    ).then(
      (value) => ({ ...value, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error
    )
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ pass: false, code: 'invalid_arguments' })
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('/private/secret')
  })

  it('CLI probes real filesystem metadata and fails closed for a missing destination', async () => {
    const run = promisify(execFile)
    const missing = '/neteco-storage-preflight-nonexistent/workspace'
    const result = await run(
      process.execPath,
      ['--import', 'tsx', 'scripts/storage-preflight.ts', `--workspace=${missing}`],
      { cwd: process.cwd() }
    ).then(
      (value) => ({ ...value, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error
    )
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      pass: false,
      checks: [{ label: 'workspace', pass: false, code: 'storage_unavailable' }, { label: 'temporary' }]
    })
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain(missing)
  })
})
