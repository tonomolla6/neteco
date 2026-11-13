import { expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { createCompiledShopFixture } from '../support/compiled-shop-fixture'
const directories = vi.hoisted(() => [] as string[])

// Check the real fixture's manifest gate and SQL application without requiring
// absent build artifacts or compiling Nuxt. Native workerd is exercised by the
// existing delivery/privacy tests alongside this targeted configuration test.
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const { resolve } = await import('node:path')
  const bundleDirectory = resolve('.wrangler/shop-bundle')
  return {
    ...fs,
    // This unit checks the real manifest/SQL with a Miniflare double. Only its
    // emitted-code inputs are stubbed; migration reads still use the real fs.
    readFile: vi.fn(async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === resolve(bundleDirectory, 'shop.js')) return 'export default {}'
      return fs.readFile(...args)
    }),
    readdir: vi.fn(async (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === bundleDirectory) return []
      return fs.readdir(...args)
    }),
    access: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn(async (prefix: string) => {
      const directory = await fs.mkdtemp(prefix)
      directories.push(directory)
      return directory
    })
  }
})
vi.mock('miniflare', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { d1OverSqlite } = await import('../support/d1-sqlite')
  return {
    NoOpLog: class {
      readonly level = 0
    },
    convertV4MiniflareOptions: (value: unknown) => value,
    Miniflare: class {
      private sqlite = new DatabaseSync(':memory:')
      constructor() {
        this.sqlite.exec('PRAGMA foreign_keys=ON')
      }
      ready = Promise.resolve()
      getD1Database() {
        return d1OverSqlite(this.sqlite)
      }
      async dispose() {
        this.sqlite.close()
      }
    }
  }
})

it('lets the compiled fixture apply the current contiguous migration manifest including the Beply outbox', async () => {
  const fixture = await createCompiledShopFixture()
  try {
    const rows = await fixture.database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'beply_order_%' ORDER BY name")
      .all<{ name: string }>()
    expect(rows.results.map((row) => row.name)).toEqual([
      'beply_order_alerts',
      'beply_order_commands',
      'beply_order_sync'
    ])
    expect(fixture.outbound.requests).toBe(0)
  } finally {
    await fixture.dispose()
    expect(directories).toHaveLength(1)
    expect(directories.every((directory) => !existsSync(directory))).toBe(true)
  }
})
