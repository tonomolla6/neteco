import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach } from 'vitest'

const formatters = new Set<DatabaseSync>()
afterEach(() => {
  for (const formatter of formatters) formatter.close()
  formatters.clear()
})

/** Clock-skew scenarios need two independent authorities. Freeze this D1
 * fixture's SQL clock while JavaScript moves; keep real SQLite formatting,
 * modifiers, parsing and CHECK semantics for every other argument.
 */
export function pinSqlClock(database: DatabaseSync, instant: string) {
  if (!Number.isFinite(Date.parse(instant))) throw new Error('invalid_fixture_sql_clock')
  const formatter = new DatabaseSync(':memory:')
  formatters.add(formatter)
  const statements = new Map<number, ReturnType<DatabaseSync['prepare']>>()
  database.function('strftime', { varargs: true, deterministic: true }, (...values) => {
    const args: SQLInputValue[] = [...values]
    if (args.length === 1) args.push(instant)
    else if (typeof args[1] === 'string' && args[1].toLowerCase() === 'now') args[1] = instant
    let statement = statements.get(args.length)
    if (!statement) {
      statement = formatter.prepare(`SELECT strftime(${args.map(() => '?').join(',')}) AS value`)
      statements.set(args.length, statement)
    }
    const value = statement.get(...args)?.value
    return typeof value === 'string' ? value : null
  })
}
