import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  evaluatePerformanceGate,
  flattenPerformanceMetrics,
  parsePerformanceExceptions,
  runPerformanceGateCli
} from '../../scripts/lib/performance-gate'

const report = (over: Record<string, number> = {}) => ({
  checks: [
    { name: 'search-load', status: 'passed', metrics: { p95Ms: 200, errorRate: 0, nested: { bytes: 1000 }, ...over } },
    { name: 'worker-drain', status: 'passed', metrics: { throughputPerSecond: 20 } },
    { name: 'broken', status: 'failed', error: 'x' }
  ]
})
const baseline = {
  schemaVersion: 1,
  metrics: { 'search-load.p95Ms': 200, 'search-load.nested.bytes': 1000, 'worker-drain.throughputPerSecond': 20 }
}
const NOW = new Date('2026-11-01T00:00:00Z')
const exception = (over = {}) => ({
  metric: 'search-load.p95Ms',
  reason: 'Temporary index rebuild',
  approvedBy: 'tono',
  createdAt: '2026-10-25T00:00:00Z',
  expiresAt: '2026-11-10T00:00:00Z',
  ...over
})

describe('flattenPerformanceMetrics', () => {
  it('flattens only numeric leaves of checks, by check name and path', () => {
    expect(flattenPerformanceMetrics(report())).toEqual({
      'search-load.p95Ms': 200,
      'search-load.errorRate': 0,
      'search-load.nested.bytes': 1000,
      'worker-drain.throughputPerSecond': 20
    })
  })
  it('ignores non-numeric and non-finite values', () => {
    const flat = flattenPerformanceMetrics({ checks: [{ name: 'a', metrics: { s: 'x', n: Number.NaN, ok: 1 } }] })
    expect(flat).toEqual({ 'a.ok': 1 })
  })
  it('rejects a malformed report', () => {
    expect(() => flattenPerformanceMetrics({})).toThrow(/report/)
  })
})

describe('evaluatePerformanceGate', () => {
  it('passes with identical metrics', () => {
    const r = evaluatePerformanceGate({ report: report(), baseline, exceptions: [], now: NOW })
    expect(r.ok).toBe(true)
    expect(r.regressions).toEqual([])
  })
  it('tolerates changes inside the tolerance', () => {
    expect(evaluatePerformanceGate({ report: report({ p95Ms: 215 }), baseline, exceptions: [], now: NOW }).ok).toBe(
      true
    )
  })
  it('fails on a lower-is-better regression and attaches a diff', () => {
    const r = evaluatePerformanceGate({ report: report({ p95Ms: 260 }), baseline, exceptions: [], now: NOW })
    expect(r.ok).toBe(false)
    expect(r.regressions.map((e) => e.metric)).toEqual(['search-load.p95Ms'])
    expect(r.diffMarkdown).toContain('| search-load.p95Ms | 200 | 260 | +30.0% | regression |')
  })
  it('treats throughput as higher-is-better', () => {
    const slow = { checks: [{ name: 'worker-drain', metrics: { throughputPerSecond: 10 } }] }
    const r = evaluatePerformanceGate({ report: slow, baseline, exceptions: [], now: NOW })
    expect(r.regressions.map((e) => e.metric)).toContain('worker-drain.throughputPerSecond')
    const fast = { checks: [{ name: 'worker-drain', metrics: { throughputPerSecond: 40 } }] }
    const only = { schemaVersion: 1, metrics: { 'worker-drain.throughputPerSecond': 20 } }
    expect(evaluatePerformanceGate({ report: fast, baseline: only, exceptions: [], now: NOW }).ok).toBe(true)
  })
  it('fails on any increase from a zero baseline of a lower-is-better metric', () => {
    const b = { schemaVersion: 1, metrics: { 'search-load.errorRate': 0 } }
    const r = evaluatePerformanceGate({ report: report({ errorRate: 0.01 }), baseline: b, exceptions: [], now: NOW })
    expect(r.ok).toBe(false)
  })
  it('waives a regression covered by a live exception and lists it', () => {
    const r = evaluatePerformanceGate({ report: report({ p95Ms: 260 }), baseline, exceptions: [exception()], now: NOW })
    expect(r.ok).toBe(true)
    expect(r.waived.map((e) => e.metric)).toEqual(['search-load.p95Ms'])
    expect(r.diffMarkdown).toContain('waived until 2026-11-10T00:00:00Z')
  })
  it('fails when an exception expired, even if the metric is fine', () => {
    const r = evaluatePerformanceGate({
      report: report(),
      baseline,
      exceptions: [exception({ expiresAt: '2026-10-31T23:59:59Z' })],
      now: NOW
    })
    expect(r.ok).toBe(false)
    expect(r.expiredExceptions).toHaveLength(1)
  })
  it('does not waive with an expired exception', () => {
    const r = evaluatePerformanceGate({
      report: report({ p95Ms: 260 }),
      baseline,
      exceptions: [exception({ expiresAt: '2026-10-31T00:00:00Z' })],
      now: NOW
    })
    expect(r.ok).toBe(false)
    expect(r.regressions).toHaveLength(1)
  })
  it('flags metrics missing from the report as regressions', () => {
    const r = evaluatePerformanceGate({ report: { checks: [] }, baseline, exceptions: [], now: NOW })
    expect(r.ok).toBe(false)
    expect(r.diffMarkdown).toContain('missing')
  })
  it('without a baseline it cannot diff and says so, while failed checks still fail', () => {
    expect(
      evaluatePerformanceGate({ report: report(), baseline: null, exceptions: [], now: NOW }).diffMarkdown
    ).toContain('No baseline')
    const failedReport = { status: 'failed', checks: report().checks }
    expect(evaluatePerformanceGate({ report: failedReport, baseline: null, exceptions: [], now: NOW }).ok).toBe(false)
  })
})

describe('parsePerformanceExceptions', () => {
  it('accepts a valid list', () => {
    expect(parsePerformanceExceptions({ exceptions: [exception()] })).toHaveLength(1)
  })
  it('rejects exceptions that outlive 30 days, lack a reason or are not canonical instants', () => {
    expect(() =>
      parsePerformanceExceptions({ exceptions: [exception({ expiresAt: '2027-01-01T00:00:00Z' })] })
    ).toThrow()
    expect(() => parsePerformanceExceptions({ exceptions: [exception({ reason: '' })] })).toThrow()
    expect(() => parsePerformanceExceptions({ exceptions: [exception({ expiresAt: '2026-11-10' })] })).toThrow()
    expect(() =>
      parsePerformanceExceptions({ exceptions: [exception({ expiresAt: '2026-10-01T00:00:00Z' })] })
    ).toThrow()
  })
})

describe('runPerformanceGateCli', () => {
  async function files(r: unknown, b: unknown, e: unknown) {
    const dir = await mkdtemp(join(tmpdir(), 'perf-gate-'))
    const p = (n: string, v: unknown) => writeFile(join(dir, n), JSON.stringify(v))
    await p('report.json', r)
    if (b) await p('baseline.json', b)
    if (e) await p('exceptions.json', e)
    return {
      dir,
      args: [
        '--report',
        join(dir, 'report.json'),
        '--baseline',
        join(dir, 'baseline.json'),
        '--exceptions',
        join(dir, 'exceptions.json'),
        '--diff-out',
        join(dir, 'diff.md'),
        '--now',
        NOW.toISOString()
      ]
    }
  }
  it('exits 0 and writes a diff when nothing regressed', async () => {
    const f = await files(report(), baseline, { exceptions: [] })
    expect(await runPerformanceGateCli(f.args)).toBe(0)
    expect(await readFile(join(f.dir, 'diff.md'), 'utf8')).toContain('Performance gate')
  })
  it('exits 1 on a regression and still writes the diff', async () => {
    const f = await files(report({ p95Ms: 400 }), baseline, { exceptions: [] })
    expect(await runPerformanceGateCli(f.args)).toBe(1)
    expect(await readFile(join(f.dir, 'diff.md'), 'utf8')).toContain('regression')
  })
  it('exits 1 on malformed exceptions and 2 on missing report', async () => {
    const f = await files(report(), baseline, { exceptions: [{ nope: true }] })
    expect(await runPerformanceGateCli(f.args)).toBe(1)
    expect(await runPerformanceGateCli(['--report', join(f.dir, 'absent.json')])).toBe(2)
  })
  it('runs without baseline file (diff impossible) but keeps failing failed reports', async () => {
    const f = await files({ status: 'failed', checks: [] }, null, null)
    expect(await runPerformanceGateCli(f.args)).toBe(1)
  })
})

describe('CI wiring', () => {
  it('runs the gate on the Oracle runner right after the performance budgets, blocking and attached', async () => {
    const workflow = parse(await readFile(resolve('.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { 'runs-on': unknown; steps: Array<{ run?: string; 'continue-on-error'?: boolean }> }>
    }
    const steps = workflow.jobs.quality!.steps
    const perf = steps.findIndex((s) => s.run === 'npm run test:performance')
    const gate = steps.findIndex((s) => s.run?.includes('scripts/performance-gate.ts'))
    expect(perf).toBeGreaterThanOrEqual(0)
    expect(gate).toBe(perf + 1)
    expect(steps[gate]!['continue-on-error']).toBeUndefined()
    expect(steps[gate]!.run).toContain('--diff-out test-results/performance-diff.md')
    expect(JSON.stringify(workflow.jobs.quality!['runs-on'])).toContain('self-hosted')
    expect(await readFile(resolve('.github/workflows/ci.yml'), 'utf8')).not.toMatch(/ubuntu-latest|continue-on-error/)
  })
})
