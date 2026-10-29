import { describe, expect, it } from 'vitest'
import { openAccountSecurityDatabase } from '../support/d1-sqlite'

describe('D1 contractual promotion storage', () => {
  it('migrates promotion rules, immutable versions, redemptions and quote evidence from empty D1', async () => {
    const sqlite = await openAccountSecurityDatabase()
    try {
      const names = sqlite
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all()
        .map((row) => row.name)
      expect(names).toEqual(
        expect.arrayContaining([
          'promotion_rules',
          'promotion_rule_versions',
          'promotion_redemptions',
          'checkout_quote_promotions'
        ])
      )
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      sqlite.close()
    }
  })

  it('stores an explicit zero-default discount without weakening immutable line snapshots', async () => {
    const sqlite = await openAccountSecurityDatabase()
    try {
      for (const table of ['checkout_quote_lines', 'order_lines']) {
        const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all()
        expect(columns).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'discount_gross_cents', notnull: 1, dflt_value: '0' })
          ])
        )
        const schema = sqlite.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)
        expect(schema?.sql).toContain('discount_gross_cents')
        const triggers = sqlite.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table)
        expect(triggers.some((row) => String(row.sql).includes('BEFORE UPDATE'))).toBe(true)
        expect(triggers.some((row) => String(row.sql).includes('BEFORE DELETE'))).toBe(true)
      }
    } finally {
      sqlite.close()
    }
  })
})
