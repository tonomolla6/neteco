import { describe, expect, it } from 'vitest'
import { sqlText } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { PRODUCTS } from '../../server/db/seed'

describe('D1 product seed', () => {
  it('renders every demo product and variant deterministically in one transaction', () => {
    const sql = renderD1ProductSeed()
    expect(sql).toBe(renderD1ProductSeed())
    expect(sql.match(/INSERT INTO products/g)).toHaveLength(PRODUCTS.length)
    expect(sql.match(/INSERT INTO variants/g)).toHaveLength(
      PRODUCTS.reduce((sum, product) => sum + product.variants.length, 0)
    )
    expect(sql.startsWith('BEGIN TRANSACTION;')).toBe(true)
    expect(sql.endsWith('COMMIT;\n')).toBe(true)
    expect(sql).not.toContain('undefined')
  })

  it('escapes apostrophes and serializes JSON as valid SQL text', () => {
    const sql = renderD1ProductSeed()
    expect(sqlText("L'Oreal")).toBe("'L''Oreal'")
    expect(sql).toContain('"badges"')
    expect(sql).toContain('"visual"')
  })
})
