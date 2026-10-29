import { readFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedInventoryFixture } from '../support/d1-sqlite'

const directory = new URL('../../db/d1/migrations/', import.meta.url)
const migration = new URL('0056_catalog_color_pattern.sql', directory)
const backup = 'catalog_color_migration_0056_backup'

describe('incremental D1 color CHECK repair without replacing variants', () => {
  let sqlite: DatabaseSync
  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys=ON')
    const historical = (await readdir(directory))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 55)
      .sort()
    expect(historical).toHaveLength(55)
    for (const name of historical) sqlite.exec(await readFile(new URL(name, directory), 'utf8'))
  })
  afterEach(() => sqlite.close())
  const apply = async () => sqlite.exec(await readFile(migration, 'utf8'))
  function snapshot() {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
    return Object.fromEntries(
      tables.map(({ name }) => {
        const table = '"' + name.replaceAll('"', '""') + '"'
        const columns = sqlite.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>
        const order = columns
          .map(({ name }) => '"' + name.replaceAll('"', '""') + '"')
          .sort()
          .join(',')
        return [name, sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY ' + order).all()]
      })
    )
  }
  const seed = () => seedInventoryFixture(sqlite)

  it('confirms the actual historical67-byte pattern fails at D1 limit50, then repairs an empty0055 schema', async () => {
    const original = sqlite.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='variants'").get()!
      .sql as string
    const pattern = /color GLOB '([^']+)'/.exec(original)![1]!
    expect(new TextEncoder().encode(pattern).byteLength).toBe(67)
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type IN('trigger','index') AND tbl_name='variants' AND lower(sql) LIKE '%color%'"
        )
        .all()
    ).toEqual([])
    sqlite.limits.likePatternLength = 50
    expect(sqlite.limits.likePatternLength).toBe(50)
    await apply()
    expect(
      sqlite
        .prepare('PRAGMA table_info(variants)')
        .all()
        .filter((column) => column.name === 'color')
    ).toHaveLength(1)
    expect(sqlite.prepare('SELECT count(*) count FROM variants').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(sqlite.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(backup)).toBeUndefined()
  })

  it('preserves existing colors, every table row, price history, stock and cascading children under foreign_keys ON', async () => {
    const world = seed(),
      variant = world.variantId(1, 1)
    const colors = [null, '#ABCDEF', '#abcdef', '#a1B2c3', '#000000', '#FFFFFF']
    for (let index = 1; index <= 6; index++)
      sqlite.prepare('UPDATE variants SET color=? WHERE id=?').run(colors[index - 1]!, world.variantId(index, 1))
    sqlite
      .prepare(
        `INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,status,reason,created_at)
      VALUES ('color-price',?,500,'2026-08-12T00:00:00Z','approved','Color migration fixture','2026-08-12T00:00:00Z')`
      )
      .run(variant)
    sqlite.exec(
      'CREATE TABLE color_test_cascading_child(id TEXT PRIMARY KEY,variant_id TEXT REFERENCES variants(id) ON DELETE CASCADE,payload TEXT) STRICT'
    )
    sqlite.prepare("INSERT INTO color_test_cascading_child VALUES ('keep-child',?,'must survive')").run(variant)
    sqlite.exec(`INSERT INTO carts(id,token_hash,correlation_id,created_at,updated_at,expires_at)
      VALUES('color-cart','${'a'.repeat(64)}','color-proof','2026-08-12T00:00:00Z','2026-08-12T00:00:00Z','2026-08-13T00:00:00Z')`)
    sqlite
      .prepare(
        "INSERT INTO cart_lines(cart_id,variant_id,quantity,created_at,updated_at) VALUES('color-cart',?,2,'2026-08-12T00:00:00Z','2026-08-12T00:00:00Z')"
      )
      .run(variant)
    const before = snapshot()
    const objects = sqlite
      .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name!='variants' ORDER BY type,name")
      .all()
    sqlite.limits.likePatternLength = 50
    await apply()
    expect(snapshot()).toEqual(before)
    expect(sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name!='variants' ORDER BY type,name").all()
    ).toEqual(objects)
    expect(sqlite.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(backup)).toBeUndefined()
    expect(sqlite.prepare('SELECT count(*) count FROM color_test_cascading_child').get()).toEqual({ count: 1 })
  })

  it('makes valid nonnull colors writable again at the real50-byte pattern limit', async () => {
    const world = seed(),
      id = world.variantId(1, 1)
    sqlite.limits.likePatternLength = 50
    expect(() => sqlite.prepare('UPDATE variants SET color=? WHERE id=?').run('#aBc123', id)).toThrow(
      /LIKE or GLOB pattern too complex/
    )
    await apply()
    for (const color of [null, '#000000', '#FFFFFF', '#abcdef', '#aBc123']) {
      sqlite.prepare('UPDATE variants SET color=? WHERE id=?').run(color, id)
      expect(sqlite.prepare('SELECT color FROM variants WHERE id=?').get(id)).toEqual({ color })
    }
    const source = sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name='variants'").get()!.sql as string
    const patterns = [...source.matchAll(/GLOB\s+'([^']+)'/g)].map((match) => match[1]!)
    expect(patterns.length).toBeGreaterThan(0)
    expect(patterns.every((pattern) => new TextEncoder().encode(pattern).byteLength <= 50)).toBe(true)
  })

  it.each([
    '',
    '#',
    '#ABC',
    'ABCDEF',
    '#ABCDE',
    '#ABCDEFG',
    '#1234567',
    '#GG0000',
    '#HH0000',
    '#abcdeG',
    '#ABCDEH',
    '#12-456',
    '#12 456',
    '#abcdef\n',
    '＃ABCDEF',
    '#ABCDEF\u0000',
    '#ABCDEF\u0000G',
    '#AB\u0000CDEF'
  ])('rejects malformed color%s without changing the existing row', async (color) => {
    const world = seed(),
      id = world.variantId(1, 1)
    sqlite.limits.likePatternLength = 50
    await apply()
    sqlite.prepare('UPDATE variants SET color=? WHERE id=?').run('#A0b1C2', id)
    const before = sqlite.prepare('SELECT * FROM variants WHERE id=?').get(id)
    expect(() => sqlite.prepare('UPDATE variants SET color=? WHERE id=?').run(color, id)).toThrow(
      /CHECK constraint failed/
    )
    expect(sqlite.prepare('SELECT * FROM variants WHERE id=?').get(id)).toEqual(before)
  })
})
