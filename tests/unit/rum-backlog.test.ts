import { describe, expect, it } from 'vitest'
import { buildRumBacklog, classifyTemplate, rumBacklogMarkdown, type RumVital } from '../../shared/rum-backlog'

const vitals = (
  path: string,
  metric: RumVital['metric'],
  values: number[],
  navigationType = 'navigate',
  deviceClass = 'mobile'
) => values.map((value) => ({ path, metric, value, navigationType, deviceClass }))
const many = (n: number, v: number) => Array.from({ length: n }, () => v)

describe('classifyTemplate', () => {
  it.each([
    ['/', 'home'],
    ['/catalogo', 'category'],
    ['/catalogo/limpieza', 'category'],
    ['/producto/lejia-5l', 'product'],
    ['/buscar', 'search'],
    ['/carrito', 'cart'],
    ['/checkout', 'checkout'],
    ['/checkout/pago', 'checkout'],
    ['/legal/aviso', 'other']
  ])('%s -> %s', (path, template) => expect(classifyTemplate(path)).toBe(template))
  it('ignores query strings and never leaks slugs', () => {
    expect(classifyTemplate('/producto/x?utm=1')).toBe('product')
  })
})

describe('buildRumBacklog', () => {
  it('ranks by real p75 per template, not by mean', () => {
    // mean of product LCP ~ 2300 (ok) but p75 is 3000 -> must be flagged
    const product = vitals('/producto/a', 'LCP', [...many(60, 1800), ...many(40, 3000)])
    const home = vitals('/', 'LCP', many(100, 1500))
    const r = buildRumBacklog({ vitals: [...product, ...home], queues: [], minSamples: 30 })
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({
      kind: 'vital',
      template: 'product',
      metric: 'LCP',
      p75: 3000,
      scope: 'template'
    })
  })
  it('uses nearest-rank p75', () => {
    const r = buildRumBacklog({
      vitals: vitals('/', 'INP', [100, 200, 300, 400, ...many(26, 450)]),
      queues: [],
      minSamples: 30
    })
    expect(r.items[0]!.p75).toBe(450)
  })
  it('prioritises the worse and the bigger-audience problems first', () => {
    const v = [
      ...vitals('/carrito', 'INP', many(40, 260)),
      ...vitals('/checkout', 'INP', many(400, 480)),
      ...vitals('/buscar', 'LCP', many(40, 2600))
    ]
    const r = buildRumBacklog({ vitals: v, queues: [], minSamples: 30 })
    expect(r.items.filter((i) => i.scope === 'template').map((i) => i.template)).toEqual(['checkout', 'cart', 'search'])
    expect(r.items[0]!.priority).toBeGreaterThan(r.items[1]!.priority)
  })
  it('surfaces cohorts hidden by a healthy template aggregate', () => {
    const v = [
      ...vitals('/producto/a', 'LCP', many(100, 1500), 'navigate', 'desktop'),
      ...vitals('/producto/a', 'LCP', many(30, 4200), 'navigate', 'mobile')
    ]
    const r = buildRumBacklog({ vitals: v, queues: [], minSamples: 30 })
    expect(r.items.find((i) => i.scope === 'template')).toBeUndefined()
    expect(r.items.find((i) => i.scope === 'cohort')).toMatchObject({
      template: 'product',
      cohort: 'mobile/navigate',
      p75: 4200
    })
  })
  it('puts cohorts with too few samples in insufficient data, never in the backlog', () => {
    const r = buildRumBacklog({ vitals: vitals('/', 'LCP', many(5, 9000)), queues: [], minSamples: 30 })
    expect(r.items).toEqual([])
    expect(r.insufficient).toEqual([expect.objectContaining({ template: 'home', metric: 'LCP', samples: 5 })])
  })
  it('includes real queue lag p75 and ranks it together with web vitals', () => {
    const queues = [
      ...many(60, 120_000).map((lagMs) => ({ queue: 'catalog-import', lagMs })),
      ...many(60, 1_000).map((lagMs) => ({ queue: 'emails', lagMs }))
    ]
    const r = buildRumBacklog({ vitals: [], queues, minSamples: 30 })
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ kind: 'queue', queue: 'catalog-import', p75: 120_000 })
  })
  it('does not let a good lab score hide a bad field p75, and flags the disagreement', () => {
    const r = buildRumBacklog({
      vitals: vitals('/', 'LCP', many(50, 3500)),
      queues: [],
      lab: [{ template: 'home', metric: 'LCP', value: 1200 }]
    })
    expect(r.items[0]).toMatchObject({ template: 'home', labDisagrees: true })
  })
  it('does not rank anything from lab data alone', () => {
    const r = buildRumBacklog({ vitals: [], queues: [], lab: [{ template: 'home', metric: 'LCP', value: 9000 }] })
    expect(r.items).toEqual([])
  })
  it('drops invalid samples (NaN, negative, unknown metric) and counts them', () => {
    const bad = [
      { path: '/', metric: 'LCP', value: Number.NaN, navigationType: 'navigate', deviceClass: 'mobile' },
      { path: '/', metric: 'LCP', value: -1, navigationType: 'navigate', deviceClass: 'mobile' },
      { path: '/', metric: 'FID', value: 5, navigationType: 'navigate', deviceClass: 'mobile' }
    ] as unknown as RumVital[]
    const r = buildRumBacklog({ vitals: [...bad, ...vitals('/', 'LCP', many(40, 1000))], queues: [] })
    expect(r.rejectedSamples).toBe(3)
    expect(r.items).toEqual([])
  })
  it('handles CLS thresholds and empty input', () => {
    const r = buildRumBacklog({ vitals: vitals('/carrito', 'CLS', many(40, 0.2)), queues: [] })
    expect(r.items[0]).toMatchObject({ metric: 'CLS', threshold: 0.1 })
    expect(buildRumBacklog({ vitals: [], queues: [] })).toMatchObject({ items: [], insufficient: [] })
  })
  it('is deterministic regardless of sample order', () => {
    const v = [...vitals('/checkout', 'INP', many(40, 480)), ...vitals('/carrito', 'INP', many(40, 480))]
    const a = buildRumBacklog({ vitals: v, queues: [] })
    const b = buildRumBacklog({ vitals: v.toReversed(), queues: [] })
    expect(a).toEqual(b)
  })
})

describe('rumBacklogMarkdown', () => {
  it('renders a ranked table with p75 and sample counts', () => {
    const r = buildRumBacklog({ vitals: vitals('/checkout', 'INP', many(40, 480)), queues: [] })
    const md = rumBacklogMarkdown(r)
    expect(md).toContain('| 1 | checkout | INP |')
    expect(md).toContain('480')
    expect(rumBacklogMarkdown(buildRumBacklog({ vitals: [], queues: [] }))).toContain('No field regressions')
  })
})
