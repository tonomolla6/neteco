import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { Agent, setGlobalDispatcher } from 'undici'
import { setTestRuntimeClock } from './deterministic'

// Opt in only when a fixture reads testNow(). Fake Date alone: transport,
// cryptography, timers and native runtime lifecycle continue using real I/O.
let ownsRuntimeClock = false
let fixtureInstant: number | undefined
let testsStarted = false
setTestRuntimeClock({
  peek: () => vi.getMockedSystemTime()?.getTime() ?? null,
  read(fallback) {
    if (!vi.getMockedSystemTime()) {
      vi.setSystemTime(fallback)
      ownsRuntimeClock = true
      fixtureInstant ??= fallback
    }
    const instant = vi.getMockedSystemTime()?.getTime() ?? fallback
    vi.setSystemTime(instant + 1)
    return instant
  }
})
beforeEach(() => {
  if (!testsStarted && ownsRuntimeClock) fixtureInstant = vi.getMockedSystemTime()?.getTime() ?? fixtureInstant
  testsStarted = true
  if (fixtureInstant !== undefined && !vi.getMockedSystemTime()) {
    vi.setSystemTime(fixtureInstant)
    ownsRuntimeClock = true
  }
})
afterEach(() => {
  if (ownsRuntimeClock) vi.useRealTimers()
  ownsRuntimeClock = false
})

const nativeFetch = globalThis.fetch
const localDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
        callback(new Error(`External network access is forbidden in tests: ${hostname}`), '', 4)
        return
      }
      const family = typeof options === 'object' && options?.family === 6 ? 6 : 4
      callback(null, family === 6 ? '::1' : '127.0.0.1', family)
    }
  }
})

export function assertLocalTestUrl(input: string | URL | Request) {
  const raw = input instanceof Request ? input.url : String(input)
  if (raw.startsWith('/')) return
  const url = new URL(raw)
  if (['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) return
  throw new Error(`External network access is forbidden in tests: ${url.origin}`)
}

beforeAll(() => {
  setGlobalDispatcher(localDispatcher)
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    assertLocalTestUrl(input)
    return nativeFetch(input, init)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = nativeFetch
  void localDispatcher.close()
})
