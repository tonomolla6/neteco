import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { d1OverSqlite } from '../support/d1-sqlite'

function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL CHECK(amount > 0)) STRICT')
  return { sqlite, database: d1OverSqlite(sqlite) }
}

it('serializes concurrent batches on the same real SQLite connection without nested transactions', async () => {
  const { sqlite, database } = fixture()
  try {
    const results = await Promise.all([
      database.batch([
        database.prepare('INSERT INTO entries VALUES(1,10)'),
        database.prepare('SELECT sum(amount) AS total FROM entries')
      ]),
      database.batch([
        database.prepare('INSERT INTO entries VALUES(2,20)'),
        database.prepare('SELECT sum(amount) AS total FROM entries')
      ])
    ])
    expect(results.map((batch) => batch[1]!.results)).toEqual([[{ total: 10 }], [{ total: 30 }]])
    expect(sqlite.prepare('SELECT * FROM entries ORDER BY id').all()).toEqual([
      { id: 1, amount: 10 },
      { id: 2, amount: 20 }
    ])
  } finally {
    sqlite.close()
  }
})

it('rolls back a failed batch before admitting its queued successor, without poisoning the connection', async () => {
  const { sqlite, database } = fixture()
  try {
    const results = await Promise.allSettled([
      database.batch([
        database.prepare('INSERT INTO entries VALUES(1,10)'),
        database.prepare('INSERT INTO entries VALUES(2,-1)')
      ]),
      database.batch([
        database.prepare('INSERT INTO entries VALUES(3,30)'),
        database.prepare('SELECT count(*) AS n FROM entries')
      ])
    ])
    expect(results[0]!.status).toBe('rejected')
    expect(results[1]).toMatchObject({
      status: 'fulfilled',
      value: [{ success: true }, { success: true, results: [{ n: 1 }] }]
    })
    expect(sqlite.prepare('SELECT * FROM entries').all()).toEqual([{ id: 3, amount: 30 }])
  } finally {
    sqlite.close()
  }
})

it('shares transaction admission across two D1 adapters wrapping one SQLite connection', async () => {
  const { sqlite, database } = fixture()
  const second = d1OverSqlite(sqlite)
  try {
    await Promise.all([
      database.batch([database.prepare('INSERT INTO entries VALUES(1,10)')]),
      second.batch([second.prepare('INSERT INTO entries VALUES(2,20)')])
    ])
    expect(sqlite.prepare('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 2 })
  } finally {
    sqlite.close()
  }
})
