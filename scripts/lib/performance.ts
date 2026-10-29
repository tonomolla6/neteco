import { gzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type postgres from 'postgres'

/** Connection startup parameters belong to connection, not client options. */
export function performanceObserverDatabaseOptions(): Pick<
  postgres.Options<Record<string, never>>,
  'max' | 'connection'
> {
  return { max: 1, connection: { application_name: 'neteco-performance-observer' } }
}

const loadProfileSchema = z.object({
  requests: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  p95Ms: z.number().positive(),
  maxErrorRate: z.number().min(0).max(1)
})

const deviceBudgetSchema = z.object({
  lcpMs: z.number().positive(),
  inpMs: z.number().positive(),
  cls: z.number().positive(),
  ttfbMs: z.number().positive(),
  initialJavaScriptGzipKb: z.number().positive(),
  initialCssGzipKb: z.number().positive(),
  lcpImageKb: z.number().positive(),
  thirdPartiesBeforeConsent: z.literal(0)
})

export const performanceBudgetsSchema = z.object({
  version: z.number().int().positive(),
  owner: z.string().min(1),
  templates: z.record(z.string().min(1), z.string().startsWith('/')),
  mobile: deviceBudgetSchema,
  desktop: deviceBudgetSchema,
  api: z.object({
    search: z.object({
      sustained: loadProfileSchema,
      spike: loadProfileSchema.extend({ successesBeforeBackpressure: z.number().int().positive() })
    }),
    callback: z.object({ spike: loadProfileSchema })
  }),
  database: z.object({
    poolSize: z.number().int().positive().max(20),
    requests: z.number().int().positive(),
    holdMs: z.number().int().positive(),
    maxElapsedMs: z.number().int().positive()
  }),
  worker: z.object({
    events: z.number().int().positive(),
    processes: z.number().int().positive().max(16),
    maxDatabaseConnections: z.number().int().positive(),
    maxDrainMs: z.number().int().positive(),
    minThroughputPerSecond: z.number().positive()
  })
})

export type PerformanceBudgets = z.infer<typeof performanceBudgetsSchema>
export type LoadProfile = z.infer<typeof loadProfileSchema>

export async function readPerformanceBudgets(path = 'docs/operations/performance-budgets.json') {
  return performanceBudgetsSchema.parse(JSON.parse(await readFile(resolve(path), 'utf8')))
}

export function percentile(values: number[], value: number) {
  if (!values.length) throw new Error('Cannot calculate a percentile for an empty sample')
  if (value < 0 || value > 1) throw new RangeError('Percentile must be between zero and one')
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)]!
}

export async function runBoundedLoad(
  profile: LoadProfile,
  request: (index: number) => Promise<boolean>
): Promise<{
  requests: number
  successes: number
  failures: number
  errorRate: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}> {
  const durations = Array<number>(profile.requests)
  let cursor = 0
  let successes = 0
  await Promise.all(
    Array.from({ length: Math.min(profile.requests, profile.concurrency) }, async () => {
      while (cursor < profile.requests) {
        const index = cursor++
        const started = performance.now()
        let passed: boolean
        try {
          passed = await request(index)
        } catch {
          passed = false
        }
        durations[index] = performance.now() - started
        if (passed) successes += 1
      }
    })
  )
  const failures = profile.requests - successes
  return {
    requests: profile.requests,
    successes,
    failures,
    errorRate: failures / profile.requests,
    p50Ms: Math.round(percentile(durations, 0.5) * 100) / 100,
    p95Ms: Math.round(percentile(durations, 0.95) * 100) / 100,
    maxMs: Math.round(Math.max(...durations) * 100) / 100
  }
}

export function assertLoadBudget(label: string, result: { p95Ms: number; errorRate: number }, profile: LoadProfile) {
  if (result.errorRate > profile.maxErrorRate) {
    throw new Error(`${label} error rate ${result.errorRate} exceeds ${profile.maxErrorRate}`)
  }
  if (result.p95Ms > profile.p95Ms) {
    throw new Error(`${label} p95 ${result.p95Ms} ms exceeds ${profile.p95Ms} ms`)
  }
}

export function initialAssetUrls(html: string) {
  return [
    ...new Set(
      [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"?]+\.(?:js|css))(?:\?[^"#]*)?"/g)].map(
        (match) => match[1]!
      )
    )
  ]
}

export async function compressedAssetBytes(urls: string[], publicDirectory = '.output/public') {
  let javascript = 0
  let css = 0
  for (const url of urls) {
    const path = new URL(url, 'http://localhost').pathname
    if (!path.startsWith('/_nuxt/')) continue
    const bytes = gzipSync(await readFile(resolve(publicDirectory, `.${path}`))).byteLength
    if (path.endsWith('.js')) javascript += bytes
    if (path.endsWith('.css')) css += bytes
  }
  return { javascript, css }
}
