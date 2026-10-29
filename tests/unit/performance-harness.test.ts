import { describe, expect, it } from 'vitest'
import postgres from 'postgres'
import {
  initialAssetUrls,
  percentile,
  performanceObserverDatabaseOptions,
  runBoundedLoad
} from '../../scripts/lib/performance'

describe('performance harness', () => {
  it('sets the observer name as a PostgreSQL startup parameter without opening a connection', async () => {
    const options = performanceObserverDatabaseOptions()
    expect(options).toEqual({ max: 1, connection: { application_name: 'neteco-performance-observer' } })
    const client = postgres('postgres://fixture:fixture@127.0.0.1:1/neteco_test', options)
    try {
      expect(client.options.max).toBe(1)
      expect(client.options.connection.application_name).toBe('neteco-performance-observer')
      options.connection.application_name = 'changed-by-caller'
      expect(performanceObserverDatabaseOptions().connection.application_name).toBe('neteco-performance-observer')
    } finally {
      await client.end({ timeout: 0 })
    }
  })

  it('calculates nearest-rank percentiles', () => {
    expect(percentile([50, 10, 30, 20, 40], 0.5)).toBe(30)
    expect(percentile([50, 10, 30, 20, 40], 0.95)).toBe(50)
    expect(() => percentile([], 0.95)).toThrow(/empty sample/)
  })

  it('extracts unique initial JavaScript and CSS assets', () => {
    const html =
      '<link rel="stylesheet" href="/_nuxt/app.css"><link rel="modulepreload" href="/_nuxt/a.js"><script src="/_nuxt/a.js"></script>'
    expect(initialAssetUrls(html)).toEqual(['/_nuxt/app.css', '/_nuxt/a.js'])
  })

  it('bounds concurrency and reports request failures', async () => {
    let active = 0
    let maximum = 0
    const result = await runBoundedLoad(
      { requests: 12, concurrency: 3, p95Ms: 100, maxErrorRate: 0.1 },
      async (index) => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 2))
        active -= 1
        return index !== 4
      }
    )
    expect(maximum).toBe(3)
    expect(result).toMatchObject({ requests: 12, successes: 11, failures: 1, errorRate: 1 / 12 })
  })
})
