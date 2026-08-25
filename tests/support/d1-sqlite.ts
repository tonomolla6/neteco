import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = ['0001_platform.sql', '0002_catalog_read_model.sql', '0003_variant_price_versions.sql'].map((name) =>
  fileURLToPath(new URL(`../../db/d1/migrations/${name}`, import.meta.url))
)

export async function openMigratedDatabase() {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const path of MIGRATIONS) database.exec(await readFile(path, 'utf8'))
  return database
}

export function applyGeneratedSeed(database: DatabaseSync, sql: string) {
  database.exec(sql)
}

type Statement = { sql: string; parameters: unknown[] }

/** Minimal D1Database adapter over node:sqlite so worker code runs against real SQLite. */
export function d1OverSqlite(database: DatabaseSync): D1Database {
  const prepareStatement = (sql: string) =>
    ({
      sql,
      parameters: [] as unknown[],
      bind(...parameters: unknown[]) {
        this.parameters = parameters
        return this
      },
      first<T>() {
        return Promise.resolve((database.prepare(sql).get(...this.parameters) as T | undefined) ?? null)
      },
      all<T>() {
        return Promise.resolve({ results: database.prepare(sql).all(...this.parameters) as T[] })
      }
    }) satisfies Statement & {
      first: <T>() => Promise<T | null>
      all: <T>() => Promise<{ results: T[] }>
    }

  return {
    prepare: prepareStatement,
    batch: async (statements: Statement[]) =>
      statements.map((statement) => ({
        results: database.prepare(statement.sql).all(...statement.parameters),
        success: true
      }))
  } as unknown as D1Database
}
