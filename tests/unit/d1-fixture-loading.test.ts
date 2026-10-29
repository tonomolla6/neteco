import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readFile: vi.fn(original.readFile) }
})

beforeEach(() => {
  vi.resetModules()
  vi.mocked(readFile).mockClear()
})

describe('fresh D1 fixtures without repeated migration-file IO', () => {
  it('reads each migration once while creating genuinely independent clean databases', async () => {
    const { openMigratedDatabase } = await import('../support/d1-sqlite')
    const first = await openMigratedDatabase()
    try {
      const reads = vi.mocked(readFile).mock.calls.length
      expect(reads).toBeGreaterThan(0)
      first.exec('CREATE TABLE fixture_only(id INTEGER PRIMARY KEY); INSERT INTO fixture_only VALUES (1)')
      const second = await openMigratedDatabase()
      try {
        expect(vi.mocked(readFile).mock.calls).toHaveLength(reads)
        expect(second.prepare("SELECT name FROM sqlite_schema WHERE name='fixture_only'").get()).toBeUndefined()
        expect(
          second.prepare("SELECT name FROM sqlite_schema WHERE name='search_synonym_commands'").get()
        ).toBeDefined()
        expect(second.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      } finally {
        second.close()
      }
    } finally {
      first.close()
    }
  })

  it('shares only source text when fixtures open concurrently, never their database state', async () => {
    const { openMigratedDatabase } = await import('../support/d1-sqlite')
    const databases = await Promise.all([openMigratedDatabase(), openMigratedDatabase()])
    try {
      const paths = vi.mocked(readFile).mock.calls.map(([path]) => String(path))
      expect(paths.length).toBeGreaterThan(0)
      expect(new Set(paths).size).toBe(paths.length)
      databases[0]!.exec('CREATE TABLE isolated_fixture(id INTEGER)')
      expect(
        databases[1]!.prepare("SELECT name FROM sqlite_schema WHERE name='isolated_fixture'").get()
      ).toBeUndefined()
    } finally {
      databases.forEach((database) => database.close())
    }
  })
})
