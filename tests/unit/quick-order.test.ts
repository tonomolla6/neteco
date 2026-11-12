import { describe, expect, it, vi } from 'vitest'
import {
  parseQuickOrderCsv,
  parseQuickOrderList,
  previewQuickOrder,
  priceQuickOrderLine,
  resolveQuickOrderReference
} from '../../shared/quick-order'

const variant = (overrides = {}) => ({
  uuid: '71000000-0000-4000-8000-000000000001',
  id: 11,
  sku: 'SKU-A',
  ean: '8412345678901',
  gtin: null,
  mpn: null,
  format: 'Caja',
  unitLabel: 'caja',
  price: 1210,
  priceTiers: [{ minimumQuantity: 6, unitGrossCents: 1089 }],
  pricingVersion: 'legacy:variant',
  taxRateBasisPoints: 2100,
  minimumQuantity: 2,
  maximumQuantity: 10,
  quantityIncrement: 2,
  stock: 8,
  backorderAllowed: false,
  ...overrides
})
const product = (variants = [variant()]) => ({ slug: 'producto-a', name: 'Producto A', variants })
const search = (...slugs: string[]) => ({ items: slugs.map((slug) => ({ slug })) })
function reader(detail = product()) {
  return vi.fn(async (path: string) => (path === '/api/search' ? search('producto-a') : detail))
}

describe('bounded quick order CSV and observed published offers', () => {
  it('requires two distinct header cells, not one quoted cell containing a comma', () => {
    expect(() => parseQuickOrderCsv('"referencia,cantidad"\nSKU-A,2')).toThrow()
  })
  it('does not expose raw server/network error messages as catalog data', async () => {
    const rows = await previewQuickOrder(
      [{ reference: 'SKU-A', quantity: 2 }],
      vi.fn(async () => {
        throw new Error('internal-secret-and-stack')
      })
    )
    expect(rows[0]).toMatchObject({ status: 'error', message: expect.stringContaining('consultar') })
    expect(JSON.stringify(rows)).not.toContain('internal-secret-and-stack')
  })
  it('does not normalize source identifiers into a false exact match', async () => {
    expect(
      (
        await previewQuickOrder([{ reference: 'SKU-A', quantity: 2 }], reader(product([variant({ sku: ' SKU-A ' })])))
      )[0]
    ).toMatchObject({ status: 'error' })
  })
  it('parses explicit CSV with BOM, CRLF, quoted reference and preserves identifier zeros', () => {
    expect(parseQuickOrderCsv('\uFEFFreferencia,cantidad\r\n"001234",2\r\nSKU-A,6\r\n')).toEqual([
      { reference: '001234', quantity: 2 },
      { reference: 'SKU-A', quantity: 6 }
    ])
  })
  it.each([
    '',
    'sku,qty\nA,1',
    'referencia,cantidad\nA,1,extra',
    'referencia,cantidad\nA,1.5',
    'referencia,cantidad\nA,0',
    'referencia,cantidad\nA,1000',
    'referencia,cantidad\nA,1\nA,2',
    'referencia,cantidad\n"unterminated,2',
    `referencia,cantidad\n${'A'.repeat(161)},1`,
    'referencia,cantidad\nA\tB,1',
    `referencia,cantidad\n${Array.from({ length: 11 }, (_, i) => `SKU-${i},1`).join('\n')}`,
    'x'.repeat(8193)
  ])('rejects malformed/oversized CSV without truncating: %s', (text) => {
    expect(() => parseQuickOrderCsv(text)).toThrow()
  })
  it('resolves exact SKU and EAN to complete variant, dedups product reads and calculates observed tier/gross/net', async () => {
    const read = reader()
    const rows = await previewQuickOrder([{ reference: 'SKU-A', quantity: 6 }], read)
    expect(rows[0]).toMatchObject({
      status: 'ready',
      variant: { id: 11 },
      unitGrossCents: 1089,
      grossCents: 6534,
      netCents: 5400,
      taxCents: 1134
    })
    expect(read).toHaveBeenCalledWith(
      '/api/search',
      expect.objectContaining({ query: { q: 'SKU-A' }, retry: 0, cache: 'no-store' })
    )
    const ean = await previewQuickOrder([{ reference: '8412345678901', quantity: 2 }], reader())
    expect(ean[0]).toMatchObject({ status: 'ready', variant: { id: 11 } })
  })
  it.each(['sku-a', 'Producto A', 'SKU'])(
    'does not turn fuzzy/name/case matches into exact references %s',
    async (reference) => {
      const rows = await previewQuickOrder([{ reference, quantity: 2 }], reader())
      expect(rows[0]).toMatchObject({ status: 'error' })
    }
  )
  it.each([1, 3, 10])('blocks quantity outside MOQ/increment/stock: %s', async (quantity) => {
    expect((await previewQuickOrder([{ reference: 'SKU-A', quantity }], reader()))[0]).toMatchObject({
      status: 'error'
    })
  })
  it('does not infer an unbounded stock maximum when backorder is enabled', async () => {
    expect(
      (
        await previewQuickOrder(
          [{ reference: 'SKU-A', quantity: 10 }],
          reader(product([variant({ backorderAllowed: true })]))
        )
      )[0]
    ).toMatchObject({ status: 'ready' })
  })
  it('blocks duplicate exact matches and duplicate variant referenced by SKU plus EAN', async () => {
    const ambiguous = await previewQuickOrder(
      [{ reference: 'SKU-A', quantity: 2 }],
      reader(product([variant(), variant({ id: 12, uuid: '71000000-0000-4000-8000-000000000002' })]))
    )
    expect(ambiguous[0]).toMatchObject({ status: 'error' })
    const read = reader()
    const duplicate = await previewQuickOrder(
      [
        { reference: 'SKU-A', quantity: 2 },
        { reference: '8412345678901', quantity: 2 }
      ],
      read
    )
    expect(duplicate.every((row) => (row as { status: string }).status === 'error')).toBe(true)
    expect(read.mock.calls.filter(([path]) => path.startsWith('/api/products/'))).toHaveLength(1)
  })
  it('accepts an exact reference in a capped search only while the ranking proves the match set is complete', async () => {
    // Exact identifiers rank first. A capped page whose first candidate matches and whose
    // second does not is complete: nothing after a non-match can be an exact match.
    const slugs = Array.from({ length: 8 }, (_, i) => `product-${i}`)
    const read = vi.fn(async (path: string) =>
      path === '/api/search'
        ? search(...slugs)
        : path.endsWith('product-0')
          ? { ...product(), slug: 'product-0' }
          : { ...product([variant({ id: 99, sku: 'OTHER', ean: null })]), slug: path.split('/').at(-1) }
    )
    const rows = await previewQuickOrder([{ reference: 'SKU-A', quantity: 2 }], read)
    expect(rows[0]).toMatchObject({ status: 'ready', variant: { id: 11 } })
    // one search, the match and the first non-match: never the whole capped page
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('blocks a capped search whose every candidate matches: the page may be truncated', async () => {
    const slugs = Array.from({ length: 8 }, (_, i) => `product-${i}`)
    const read = vi.fn(async (path: string) =>
      path === '/api/search'
        ? search(...slugs)
        : {
            ...product([variant({ id: Number(path.at(-1)) + 1, sku: `S-${path.at(-1)}`, ean: null, mpn: 'SKU-A' })]),
            slug: path.split('/').at(-1)
          }
    )
    expect((await previewQuickOrder([{ reference: 'SKU-A', quantity: 2 }], read))[0]).toMatchObject({ status: 'error' })
  })
  it('suggests the closest observed reference when there is no exact match', async () => {
    const rows = await previewQuickOrder([{ reference: 'SKU', quantity: 2 }], reader())
    expect(rows[0]).toMatchObject({
      status: 'error',
      message: 'No encontramos «SKU».',
      suggestion: { reference: 'SKU-A', name: 'Producto A', format: 'Caja' }
    })
  })
  it('enforces a 20 unique-detail budget, and reports unavailable/malformed reads as errors rather than no matches', async () => {
    const read = vi.fn(async (path: string, options: object) =>
      path === '/api/search'
        ? search(...Array.from({ length: 7 }, (_, i) => `p-${(options as { query: { q: string } }).query.q}-${i}`))
        : product()
    )
    const rows = await previewQuickOrder(
      Array.from({ length: 4 }, (_, i) => ({ reference: `SKU${i}`, quantity: 2 })),
      read
    )
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => (row as { status: string }).status === 'error')).toBe(true)
    expect(read.mock.calls.filter(([path]) => path.startsWith('/api/products/')).length).toBeLessThanOrEqual(20)
    for (const result of [{ items: null }, { items: [{ slug: '../private' }] }]) {
      expect(
        (
          await previewQuickOrder(
            [{ reference: 'SKU-A', quantity: 2 }],
            vi.fn(async () => result)
          )
        )[0]
      ).toMatchObject({ status: 'error' })
    }
    expect(
      (
        await previewQuickOrder(
          [{ reference: 'SKU-A', quantity: 2 }],
          vi.fn(async () => {
            throw new Error('offline')
          })
        )
      )[0]
    ).toMatchObject({ status: 'error' })
  })
  it('rejects detail slug mismatch, invalid variants/pricing and unsafe amounts', async () => {
    for (const detail of [
      { ...product(), slug: 'different' },
      product([variant({ id: null })]),
      product([variant({ price: NaN })]),
      product([variant({ priceTiers: [{ minimumQuantity: 2, unitGrossCents: 9999 }] })]),
      product([variant({ price: Number.MAX_SAFE_INTEGER })])
    ]) {
      expect((await previewQuickOrder([{ reference: 'SKU-A', quantity: 2 }], reader(detail)))[0]).toMatchObject({
        status: 'error'
      })
    }
  })
  it('requires explicit bounded input even when called outside the CSV parser', async () => {
    const read = reader()
    await expect(
      previewQuickOrder(
        Array.from({ length: 11 }, () => ({ reference: 'SKU-A', quantity: 2 })),
        read
      )
    ).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('pasted lists and per-reference resolution', () => {
  it('reads one product per line with space, tab, comma or semicolon and an optional quantity', () => {
    expect(parseQuickOrderList('1042 2\n1133\t4\n990;3\nSKU-A,6\n\n  0077  \n')).toEqual({
      rows: [
        { reference: '1042', quantity: 2 },
        { reference: '1133', quantity: 4 },
        { reference: '990', quantity: 3 },
        { reference: 'SKU-A', quantity: 6 },
        { reference: '0077', quantity: 1 }
      ],
      problems: []
    })
  })
  it('skips a header row and a spreadsheet quote, and tolerates CRLF and a BOM', () => {
    expect(parseQuickOrderList('\uFEFFReferencia;Cantidad\r\n"1042";2\r\n').rows).toEqual([
      { reference: '1042', quantity: 2 }
    ])
  })
  it('reports unusable lines without dropping the valid ones', () => {
    const parsed = parseQuickOrderList('1042 2\n1133 mucho\n1042 5\n990 0\nA 1')
    expect(parsed.rows).toEqual([{ reference: '1042', quantity: 2 }])
    expect(parsed.problems.map((problem) => [problem.line, problem.message])).toEqual([
      [2, 'La cantidad debe ser un número entero entre 1 y 999.'],
      [3, 'La referencia 1042 está repetida; deja una sola línea con la cantidad total.'],
      [4, 'La cantidad debe ser un número entero entre 1 y 999.'],
      [5, 'La referencia debe tener al menos 2 caracteres.']
    ])
  })
  it('caps the list instead of silently truncating it', () => {
    const parsed = parseQuickOrderList(Array.from({ length: 35 }, (_, i) => `REF-${i} 1`).join('\n'))
    expect(parsed.rows).toHaveLength(30)
    expect(parsed.problems).toEqual([
      {
        line: 31,
        text: 'REF-30 1',
        message: 'Máximo 30 referencias por pedido rápido. Añade estas y repite con el resto.'
      }
    ])
  })
  it('resolves one reference to its variant without requiring a quantity', async () => {
    const found = await resolveQuickOrderReference('SKU-A', reader())
    expect(found).toMatchObject({ status: 'found', name: 'Producto A', slug: 'producto-a', variant: { id: 11 } })
    const missing = await resolveQuickOrderReference(
      'NOPE',
      vi.fn(async () => search())
    )
    expect(missing).toEqual({ status: 'error', message: 'No encontramos «NOPE».' })
  })
  it('prices a line with the volume tier that the quantity reaches', () => {
    expect(priceQuickOrderLine(variant(), 2)).toEqual({
      unitGrossCents: 1210,
      grossCents: 2420,
      netCents: 2000,
      taxCents: 420
    })
    expect(priceQuickOrderLine(variant(), 6)).toMatchObject({ unitGrossCents: 1089, grossCents: 6534 })
    expect(() => priceQuickOrderLine(variant(), 3)).toThrow()
  })
})
