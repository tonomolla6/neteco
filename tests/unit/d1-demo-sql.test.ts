import { readFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'

it('runs all original migrations as single valid statements without changing their semantics', async () => {
  const database = new DatabaseSync(':memory:')
  const original = new DatabaseSync(':memory:')
  try {
    const files = (await readdir('db/d1/migrations')).filter((name) => name.endsWith('.sql')).sort()
    for (const name of files) {
      const sql = await readFile(`db/d1/migrations/${name}`, 'utf8')
      original.exec(sql)
      for (const statement of splitDemoSql(sql)) database.exec(statement)
    }
    const projection = (db: DatabaseSync) =>
      db.prepare("SELECT type,name,tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    expect(files).toContain('0053_catalog_editorial_import.sql')
    expect(files.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: files.length }, (_, index) => index + 1)
    )
    expect(projection(database)).toEqual(projection(original))
  } finally {
    database.close()
    original.close()
  }
})
it('preserves END punctuation in quoted data and strips only transaction wrappers', () => {
  const parts = splitDemoSql(
    "BEGIN TRANSACTION; SELECT 'literal END,) quoted ''END,''', CASE WHEN 1 THEN 1 ELSE 2 END, 3; COMMIT;"
  )
  expect(parts).toHaveLength(1)
  expect(parts[0]).toContain("'literal END,) quoted ''END,''' ".trim())
  const db = new DatabaseSync(':memory:')
  try {
    expect(db.prepare(parts[0]!).get()).toBeDefined()
  } finally {
    db.close()
  }
})
