import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { deterministicTestData } from '../fixtures/deterministic'
import { exportD1AdminOrders } from '../../workers/catalog/order-export'
import { listD1AdminOrders } from '../../workers/catalog/admin-orders'
import { parseAdminOrderQuery } from '../../workers/catalog/admin-orders-http'
import { parseCatalogCsvCells } from '../../shared/catalog-tabular-core'
import {
  ORDER_EXPORT_COLUMNS,
  ORDER_EXPORT_MAX_BYTES,
  verifyOrderExportCsv,
  orderExportCsvCell
} from '../../shared/order-export'
const data = deterministicTestData('order-export', '2026-10-08T12:00:00Z')
let f: Awaited<ReturnType<typeof returnsFixture>>, pending: string, paid: string
const options = { now: () => utc() }
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(data.date())
  f = await returnsFixture()
  f.sqlite.function('export_test_clock', () => utc())
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql: string) => prepare(sql.replaceAll("'now'", 'export_test_clock()'))
  pending = await f.order({ paid: false, delivered: false })
  paid = await f.order({ paid: true, delivered: false })
})
afterEach(() => {
  f.sqlite.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const read = (query = '') => exportD1AdminOrders(f.database, CLAIMS, new URLSearchParams(query), options)
function rows(csv: string) {
  return parseCatalogCsvCells(csv.slice(1)).slice(1)
}
describe('bounded private administrative order CSV snapshot', () => {
  it.each([
    '',
    'bucket=por_cobrar',
    'bucket=por_preparar',
    'bucket=incidencia',
    'paymentStatus=captured',
    'orderStatus=awaiting_payment',
    'shippingMethod=pickup',
    'customerType=b2c',
    'from=2026-10-08&to=2026-10-08',
    'sortKey=total&sortDir=asc',
    'sortKey=name&sortDir=desc',
    'sortKey=id&sortDir=asc',
    'q=%25_'
  ])('exports exactly the existing workbench filtered order for %s', async (query) => {
    const parsed = parseAdminOrderQuery(new URLSearchParams(query))!
    const list = await listD1AdminOrders(f.database, CLAIMS, utc(), parsed)
    expect(list.outcome).toBe('found')
    if (list.outcome !== 'found') throw new Error('fixture denied')
    const before = f.sqlite.prepare('SELECT total_changes() n').get()
    const result = await read(query)
    const bytes = new TextEncoder().encode(result.csv)
    expect(result.metadata).toEqual({ source: 'cloudflare', rows: list.data.items.length, bytes: bytes.byteLength })
    verifyOrderExportCsv(bytes, result.metadata)
    expect(rows(result.csv)).toEqual(
      list.data.items.map((item) =>
        ORDER_EXPORT_COLUMNS.map((column) => String((column === 'totalGrossCents' ? item.total : item[column]) ?? ''))
      )
    )
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
  it('uses a single data SELECT without paging/count roundtrips and returns a header for zero rows', async () => {
    const prepare = vi.spyOn(f.database, 'prepare')
    const result = await read('q=not-an-existing-buyer')
    expect(result.metadata.rows).toBe(0)
    expect(parseCatalogCsvCells(result.csv.slice(1))).toEqual([[...ORDER_EXPORT_COLUMNS]])
    const dataQueries = prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes('FROM orders'))
    expect(dataQueries).toHaveLength(1)
    expect(dataQueries[0]).not.toContain('OFFSET')
  })
  it('uses the exact literal id search and stable tie order', async () => {
    expect(rows((await read('q=' + pending)).csv).map((row) => row[0])).toEqual([pending])
    expect(rows((await read('q=' + paid)).csv).map((row) => row[0])).toEqual([paid])
  })
  it.each([
    'page=1',
    'perPage=25',
    'q=x&q=x',
    'carrier=made-up',
    'from=2026-02-31',
    'sortDir=drop',
    'from=2026-10-09&to=2026-10-08'
  ])('rejects invalid transport or semantic query %s', async (query) => {
    await expect(read(query)).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('does not expose private tokens, addresses, notes or arbitrary fields', async () => {
    const result = await read()
    expect(parseCatalogCsvCells(result.csv.slice(1))[0]).toEqual([...ORDER_EXPORT_COLUMNS])
    expect(result.csv).not.toContain('Carrer Major')
    expect(result.csv).not.toContain('token_hash')
    expect(result.csv).not.toContain('payload_json')
    expect(result.csv).not.toContain('600111222')
  })
  it.each(['=1+1', '+SUM(1,1)', '-1+2', '@command', ' \t=1+1', '\u00a0=1+1', '"quoted", value\r\nnext'])(
    'quotes and neutralizes spreadsheet cell %j with the reused CSV implementation',
    (value) => {
      const cell = orderExportCsvCell(value)
      expect(parseCatalogCsvCells(cell + '\r\n')[0]![0]).toBe(/^[=+\-@]/u.test(value.trimStart()) ? "'" + value : value)
    }
  )
  it.each(['session', 'email', 'mfa', 'grant'] as const)(
    'rechecks live admin %s after the snapshot SELECT',
    async (change) => {
      const original = f.database.prepare.bind(f.database)
      const database = new Proxy(f.database, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              const statement = original(sql)
              if (!sql.includes('export_candidates')) return statement
              return {
                bind(...args: unknown[]) {
                  const bound = statement.bind(...args)
                  return {
                    async all() {
                      const result = await bound.all()
                      if (change === 'session')
                        f.sqlite
                          .prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?')
                          .run(utc(), CLAIMS.sessionId)
                      if (change === 'email')
                        f.sqlite
                          .prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?')
                          .run(CLAIMS.identityId)
                      if (change === 'mfa')
                        f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
                      if (change === 'grant')
                        f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CLAIMS.identityId)
                      return result
                    }
                  }
                }
              }
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }) as D1Database
      await expect(exportD1AdminOrders(database, CLAIMS, new URLSearchParams(), options)).rejects.toMatchObject({
        code:
          change === 'session'
            ? 'unauthenticated'
            : change === 'email'
              ? 'email_unverified'
              : change === 'mfa'
                ? 'mfa_required'
                : 'forbidden'
      })
    }
  )
  it('denies customers and missing sessions before reading private rows', async () => {
    await expect(exportD1AdminOrders(f.database, null, new URLSearchParams(), options)).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    await expect(exportD1AdminOrders(f.database, BUYER_CLAIMS, new URLSearchParams(), options)).rejects.toMatchObject({
      code: 'mfa_required'
    })
  })
  it('measures UTF-8, escaped quotes, CRLF and Unicode formula protection exactly in SQL', async () => {
    const name = '\u00a0=Ácido "Ñandú",\r\ntexto'
    // Exercise the exact SQL byte measurement without modifying an immutable
    // contractual checkout snapshot. Only this test's selected name varies.
    const prepare = f.database.prepare.bind(f.database)
    f.database.prepare = (sql: string) =>
      prepare(
        sql.includes('export_candidates')
          ? sql.replaceAll('o.contact_name', "'" + name.replaceAll("'", "''") + "'")
          : sql
      )
    const result = await read('q=' + pending)
    expect(rows(result.csv)[0]![7]).toBe("'" + name)
    expect(result.metadata.bytes).toBe(new TextEncoder().encode(result.csv).byteLength)
    verifyOrderExportCsv(new TextEncoder().encode(result.csv), result.metadata)
  })
  it('uses a fresh final clock when the session expires during the data SELECT', async () => {
    f.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run('2026-10-08T12:00:01Z', CLAIMS.sessionId)
    const prepare = f.database.prepare.bind(f.database)
    f.database.prepare = (sql: string) => {
      const statement = prepare(sql)
      if (!sql.includes('export_candidates')) return statement
      return new Proxy(statement, {
        get(target, key) {
          if (key === 'bind')
            return (...args: unknown[]) => {
              const bound = target.bind(...args)
              return new Proxy(bound, {
                get(inner, property) {
                  if (property === 'all')
                    return async () => {
                      const result = await inner.all()
                      vi.setSystemTime(data.date(2000))
                      return result
                    }
                  const value = Reflect.get(inner, property)
                  return typeof value === 'function' ? value.bind(inner) : value
                }
              })
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
    await expect(read()).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it.each([
    { rowCount: 1001, totalBytes: 10000 },
    { rowCount: 1, totalBytes: ORDER_EXPORT_MAX_BYTES + 1 }
  ])('rejects over-budget SQL metadata without partial rows: %j', async (budget) => {
    const original = f.database.prepare.bind(f.database)
    const database = new Proxy(f.database, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) =>
            sql.includes('export_candidates')
              ? {
                  bind() {
                    return {
                      all: async () => ({
                        success: true,
                        meta: { rows_written: 0 },
                        results: [{ ...budget, exportOrdinal: null, id: null }]
                      })
                    }
                  }
                }
              : original(sql)
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as D1Database
    await expect(exportD1AdminOrders(database, CLAIMS, new URLSearchParams(), options)).rejects.toMatchObject({
      code: 'export_too_large'
    })
  })
})
