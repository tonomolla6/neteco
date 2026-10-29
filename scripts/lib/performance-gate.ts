import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

/** PER-020: compares a performance report with a committed baseline, attaches a
 * Markdown diff and honours only temporary, expiring, approved exceptions. */

export const PERFORMANCE_GATE_TOLERANCE = 0.1
export const PERFORMANCE_EXCEPTION_MAX_DAYS = 30

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

export const performanceExceptionSchema = z
  .object({
    metric: z.string().min(1).max(200),
    reason: z.string().trim().min(1).max(500),
    approvedBy: z.string().trim().min(1).max(100),
    createdAt: instant,
    expiresAt: instant
  })
  .strict()
  .refine(
    (entry) => {
      const span = Date.parse(entry.expiresAt) - Date.parse(entry.createdAt)
      return span > 0 && span <= PERFORMANCE_EXCEPTION_MAX_DAYS * 86_400_000
    },
    { message: `exception must expire within ${PERFORMANCE_EXCEPTION_MAX_DAYS} days after creation` }
  )
export type PerformanceException = z.infer<typeof performanceExceptionSchema>

const baselineSchema = z.object({ schemaVersion: z.literal(1), metrics: z.record(z.string(), z.number().finite()) })
export type PerformanceBaseline = z.infer<typeof baselineSchema>

export function parsePerformanceExceptions(input: unknown): PerformanceException[] {
  return z
    .object({ exceptions: z.array(performanceExceptionSchema).max(100) })
    .strict()
    .parse(input).exceptions
}

export function flattenPerformanceMetrics(report: unknown): Record<string, number> {
  const checks = (report as { checks?: unknown } | null)?.checks
  if (!Array.isArray(checks)) throw new Error('Invalid performance report: checks[] missing')
  const flat: Record<string, number> = {}
  const walk = (prefix: string, value: unknown, depth: number) => {
    if (typeof value === 'number') {
      if (Number.isFinite(value)) flat[prefix] = value
      return
    }
    if (depth > 6 || !value || typeof value !== 'object' || Array.isArray(value)) return
    for (const [key, child] of Object.entries(value)) walk(`${prefix}.${key}`, child, depth + 1)
  }
  for (const check of checks as Array<{ name?: unknown; metrics?: unknown }>) {
    if (typeof check?.name === 'string') walk(check.name, check.metrics, 0)
  }
  return flat
}

const higherIsBetter = (metric: string) => /throughput|successes/i.test(metric)

export interface GateEntry {
  metric: string
  baseline: number
  current: number | null
  changePct: number | null
  status: 'ok' | 'regression' | 'missing' | 'waived'
  waivedUntil?: string
}

export interface GateResult {
  ok: boolean
  entries: GateEntry[]
  regressions: GateEntry[]
  waived: GateEntry[]
  expiredExceptions: PerformanceException[]
  diffMarkdown: string
}

export function evaluatePerformanceGate(input: {
  report: unknown
  baseline: PerformanceBaseline | null
  exceptions: PerformanceException[]
  now: Date
  tolerance?: number
}): GateResult {
  const tolerance = input.tolerance ?? PERFORMANCE_GATE_TOLERANCE
  const current = flattenPerformanceMetrics(input.report)
  const reportFailed = (input.report as { status?: string }).status === 'failed'
  const expiredExceptions = input.exceptions.filter((entry) => Date.parse(entry.expiresAt) <= input.now.getTime())
  const live = new Map(
    input.exceptions.filter((entry) => Date.parse(entry.expiresAt) > input.now.getTime()).map((e) => [e.metric, e])
  )
  const entries: GateEntry[] = []
  for (const [metric, base] of Object.entries(input.baseline?.metrics ?? {})) {
    const now = current[metric]
    let status: GateEntry['status'] = 'ok'
    let changePct: number | null = null
    if (now === undefined) status = 'missing'
    else {
      const worse = higherIsBetter(metric) ? base - now : now - base
      changePct = base === 0 ? (now === 0 ? 0 : Math.sign(now) * 100) : ((now - base) / Math.abs(base)) * 100
      if (worse > 0 && (base === 0 || worse / Math.abs(base) > tolerance)) status = 'regression'
    }
    const exception = live.get(metric)
    if (status !== 'ok' && exception) {
      entries.push({
        metric,
        baseline: base,
        current: now ?? null,
        changePct,
        status: 'waived',
        waivedUntil: exception.expiresAt
      })
    } else entries.push({ metric, baseline: base, current: now ?? null, changePct, status })
  }
  const regressions = entries.filter((entry) => entry.status === 'regression' || entry.status === 'missing')
  const waived = entries.filter((entry) => entry.status === 'waived')
  const ok = !reportFailed && !regressions.length && !expiredExceptions.length
  const fmt = (value: number | null) => (value === null ? 'n/a' : String(Math.round(value * 1000) / 1000))
  const lines = [
    '# Performance gate',
    '',
    `Result: **${ok ? 'PASSED' : 'FAILED'}** (tolerance ${(tolerance * 100).toFixed(0)}%)`,
    ''
  ]
  if (reportFailed) lines.push('The performance report itself contains failed checks.', '')
  if (!input.baseline) lines.push('No baseline available: relative diff skipped; absolute budgets still apply.', '')
  else {
    lines.push('| Metric | Baseline | Current | Change | Status |', '| --- | --- | --- | --- | --- |')
    for (const e of entries) {
      const change = e.changePct === null ? 'n/a' : `${e.changePct >= 0 ? '+' : ''}${e.changePct.toFixed(1)}%`
      const status = e.status === 'waived' ? `waived until ${e.waivedUntil}` : e.status
      lines.push(`| ${e.metric} | ${fmt(e.baseline)} | ${fmt(e.current)} | ${change} | ${status} |`)
    }
    lines.push('')
  }
  for (const entry of expiredExceptions) {
    lines.push(`Expired exception for ${entry.metric} (expired ${entry.expiresAt}): remove it or fix the regression.`)
  }
  return { ok, entries, regressions, waived, expiredExceptions, diffMarkdown: `${lines.join('\n')}\n` }
}

function option(argv: string[], name: string) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

async function readJson(path: string) {
  return JSON.parse(await readFile(resolve(path), 'utf8')) as unknown
}

/** Exit codes: 0 passed, 1 gate failed or exceptions invalid, 2 unusable inputs. */
export async function runPerformanceGateCli(argv: string[], log: (line: string) => void = () => undefined) {
  const reportPath = option(argv, '--report') ?? 'test-results/performance.json'
  const baselinePath = option(argv, '--baseline') ?? 'docs/operations/performance-baseline.json'
  const exceptionsPath = option(argv, '--exceptions') ?? 'docs/operations/performance-exceptions.json'
  const diffOut = option(argv, '--diff-out') ?? 'test-results/performance-diff.md'
  const now = new Date(option(argv, '--now') ?? Date.now())
  let report: unknown
  try {
    report = await readJson(reportPath)
  } catch (error) {
    log(`Cannot read performance report ${reportPath}: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  let baseline: PerformanceBaseline | null = null
  let exceptions: PerformanceException[] = []
  let invalid: string | null = null
  try {
    baseline = baselineSchema.parse(await readJson(baselinePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalid = `Invalid baseline: ${String(error)}`
  }
  try {
    exceptions = parsePerformanceExceptions(await readJson(exceptionsPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalid = `Invalid exceptions: ${String(error)}`
  }
  const result = evaluatePerformanceGate({ report, baseline, exceptions, now })
  const markdown = invalid ? `${result.diffMarkdown}\n${invalid}\n` : result.diffMarkdown
  await mkdir(dirname(resolve(diffOut)), { recursive: true })
  await writeFile(resolve(diffOut), markdown, 'utf8')
  log(markdown)
  return result.ok && !invalid ? 0 : 1
}
