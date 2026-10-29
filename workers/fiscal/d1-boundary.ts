import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'

export class FiscalD1EvidenceError extends Error {
  readonly code = 'read_unconfirmed'
  constructor() {
    super('fiscal_d1_evidence_unconfirmed')
    this.name = 'FiscalD1EvidenceError'
  }
}
function denseArray(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new FiscalD1EvidenceError()
  const items: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new FiscalD1EvidenceError()
    items.push(descriptor.value)
  }
  return items
}
function ownRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FiscalD1EvidenceError()
  try {
    return catalogPolicyOwnJson(value) as Record<string, unknown>
  } catch {
    throw new FiscalD1EvidenceError()
  }
}
function envelope(value: unknown): D1Result {
  if (!value || typeof value !== 'object') throw new FiscalD1EvidenceError()
  const success = Object.getOwnPropertyDescriptor(value, 'success'),
    results = Object.getOwnPropertyDescriptor(value, 'results')
  if (
    !success ||
    !Object.hasOwn(success, 'value') ||
    success.value !== true ||
    !results ||
    !Object.hasOwn(results, 'value')
  )
    throw new FiscalD1EvidenceError()
  const rows = denseArray(results.value, 1000).map(ownRow)
  return { success: true, results: rows } as D1Result
}
export function fiscalBatchEvidence(value: unknown, expected: number): D1Result[] {
  const items = denseArray(value, expected)
  if (items.length !== expected) throw new FiscalD1EvidenceError()
  return items.map(envelope)
}
const wrappers = new WeakMap<object, D1Database>(),
  rawStatements = new WeakMap<object, D1PreparedStatement>()
/** Preserve native prepared statements at the platform batch boundary. The
 * wrappers validate every response without invoking provider getters or losing
 * evidence as an empty list/not-found. Native D1 meta is not needed here. */
export function guardedFiscalDatabase(database: D1Database): D1Database {
  const previous = wrappers.get(database)
  if (previous) return previous
  function wrap(raw: D1PreparedStatement, sql: string): D1PreparedStatement {
    const statement = {
      bind(...args: unknown[]) {
        return wrap(raw.bind(...args), sql)
      },
      async first<T>() {
        const row = await raw.first()
        if (row === null) return null
        const result = ownRow(row)
        if (sql.includes('AS permitted')) {
          if (
            !catalogPolicyUuidSchema.safeParse(result.id).success ||
            ![0, 1].includes(Number(result.mfa_verified)) ||
            typeof result.mfa_verified !== 'number' ||
            ![0, 1].includes(Number(result.email_verified)) ||
            typeof result.email_verified !== 'number' ||
            ![0, 1].includes(Number(result.permitted)) ||
            typeof result.permitted !== 'number'
          )
            throw new FiscalD1EvidenceError()
        }
        if (sql.includes('SELECT c.id FROM auth_sessions') && !catalogPolicyUuidSchema.safeParse(result.id).success)
          throw new FiscalD1EvidenceError()
        return result as T
      },
      async all<T>() {
        return envelope(await raw.all()) as D1Result<T>
      },
      async run() {
        const result = await raw.run()
        const flag = result && Object.getOwnPropertyDescriptor(result, 'success')
        if (!flag || !Object.hasOwn(flag, 'value') || flag.value !== true) throw new FiscalD1EvidenceError()
        return result
      }
    } as D1PreparedStatement
    rawStatements.set(statement, raw)
    return statement
  }
  const result = {
    prepare(sql: string) {
      return wrap(database.prepare(sql), sql)
    },
    async batch(statements: D1PreparedStatement[]) {
      const native = statements.map((statement) => rawStatements.get(statement) ?? statement)
      return fiscalBatchEvidence(await database.batch(native), native.length)
    }
  } as D1Database
  wrappers.set(database, result)
  wrappers.set(result, result)
  return result
}
