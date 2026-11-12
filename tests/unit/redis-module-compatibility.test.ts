import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { createApp, createError, eventHandler, toWebHandler } from 'h3'
import { serve, type Server } from 'srvx/node'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The transport is synthetic; the Redis constructor and application modules
// are real. This does not claim acceptance against a deployed Redis server.
const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const rootPackage = require.resolve('ioredis/package.json')
const rootVersion = JSON.parse(readFileSync(rootPackage, 'utf8')).version
const providerPackage =
  rootVersion === manifest.dependencies.ioredis
    ? rootPackage
    : resolve(rootPackage, '../../nitropack/node_modules/ioredis/package.json')
const providerVersion = JSON.parse(readFileSync(providerPackage, 'utf8')).version
const RealRedis = require(resolve(providerPackage, '../built/index.js')).default

async function respFixture() {
  const commands: string[][] = [],
    failures: string[] = []
  const server = spawn('/usr/bin/python3', ['-u', resolve('tests/support/redis-resp-fixture.py')])
  const lines = createInterface({ input: server.stdout })
  let remaining: number | undefined
  const exited = new Promise<number | null>((done) => {
    server.once('error', () => done(null))
    server.once('close', (code) => done(code))
  })
  let serverPort: number
  try {
    serverPort = await new Promise<number>((done, reject) => {
      server.once('error', reject)
      server.once('exit', (code) => reject(new Error(`RESP fixture exited before readiness: ${code}`)))
      lines.on('line', (line) => {
        const event = JSON.parse(line) as {
          kind: string
          port?: number
          command?: string[]
          message?: string
          remaining?: number
        }
        if (event.kind === 'ready' && event.port) done(event.port)
        else if (event.kind === 'command' && event.command) commands.push(event.command)
        else if (event.kind === 'failure') failures.push(event.message ?? 'unknown_resp_failure')
        else if (event.kind === 'closed') remaining = event.remaining
      })
    })
  } catch (error) {
    server.kill()
    await exited
    lines.close()
    throw error
  }
  return {
    url: `redis://127.0.0.1:${serverPort}/0`,
    commands,
    failures,
    async dispose() {
      if (!server.stdin.destroyed) server.stdin.end()
      expect(await exited).toBe(0)
      expect(remaining).toBe(0)
      lines.close()
    }
  }
}

async function modules() {
  expect(manifest.dependencies.ioredis).toBe('5.11.1')
  expect(providerVersion).toBe(manifest.dependencies.ioredis)
  vi.resetModules()
  // Alias only to an installed, version-checked real provider. The provisional
  // Nitro path is needed while this worktree's installed root is still v6;
  // npm ci installs declared root v5, and this fallback then is not used.
  vi.doMock('ioredis', () => ({ default: RealRedis }))
  return {
    redis: await import('../../server/db/redis'),
    rate: await import('../../server/utils/rate-limit')
  }
}
afterEach(() => {
  vi.doUnmock('ioredis')
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('declared ioredis v5 application-module compatibility', () => {
  it('uses real lazy lifecycle/options and enforces Lua rate limiting over loopback RESP', async () => {
    const { redis, rate } = await modules()
    const fixture = await respFixture()
    let http: Server | undefined
    try {
      vi.stubEnv('REDIS_URL', fixture.url)
      vi.stubEnv('REDIS_KEY_PREFIX', 'synthetic-compat:')
      vi.stubEnv('APP_ENV', 'production')
      vi.stubGlobal('createError', createError)
      const client = redis.useRedis()
      expect(client).toBeInstanceOf(RealRedis)
      expect(redis.useRedis()).toBe(client)
      expect(client.status).toBe('wait')
      expect(fixture.commands).toHaveLength(0)
      expect(client.options).toMatchObject({
        lazyConnect: true,
        keyPrefix: 'synthetic-compat:',
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 3000,
        commandTimeout: 3000
      })
      expect(client.listenerCount('error')).toBeGreaterThan(0)
      await client.connect()
      expect(await client.ping()).toBe('PONG')
      const app = createApp().use(
        eventHandler(async (event) => {
          await rate.enforceRateLimit(event, { scope: 'compatibility', limit: 1, windowSeconds: 60 })
          return { ok: true }
        })
      )
      http = serve({ fetch: toWebHandler(app), hostname: '127.0.0.1', port: 0, silent: true })
      await http.ready()
      if (!http.url) throw new Error('loopback_address_required')
      const first = await fetch(http.url)
      expect(first.status).toBe(200)
      expect(first.headers.get('x-ratelimit-remaining')).toBe('0')
      await first.arrayBuffer()
      const second = await fetch(http.url)
      expect(second.status).toBe(429)
      expect(second.headers.get('retry-after')).toBe('59')
      await second.arrayBuffer()
      await vi.waitFor(() =>
        expect(fixture.commands.filter((command) => command[0]!.toUpperCase() === 'EVAL')).toHaveLength(2)
      )
      const evals = fixture.commands.filter((command) => command[0]!.toUpperCase() === 'EVAL')
      expect(evals).toHaveLength(2)
      expect(evals[0]![1]).toContain("redis.call('PEXPIRE'")
      expect(evals[0]![2]).toBe('1')
      expect(evals[0]![3]).toMatch(/^synthetic-compat:neteco:rate:compatibility:[a-f0-9]{64}$/)
      expect(evals[0]![4]).toBe('60000')
      await redis.closeRedis()
      await vi.waitFor(() => expect(client.status).toBe('end'))
      await vi.waitFor(() =>
        expect(fixture.commands.filter((command) => command[0]!.toUpperCase() === 'QUIT')).toHaveLength(1)
      )
      expect(fixture.failures).toEqual([])
    } finally {
      try {
        await redis.closeRedis()
      } finally {
        try {
          await http?.close(true)
        } finally {
          await fixture.dispose()
        }
      }
    }
  })

  it('cleans an unavailable real connection and reconnects with a new singleton', async () => {
    const { redis } = await modules()
    const fixture = await respFixture()
    try {
      const reserved = await respFixture()
      const unavailable = reserved.url
      await reserved.dispose()
      vi.stubEnv('REDIS_URL', unavailable)
      vi.stubEnv('APP_ENV', 'production')
      const failed = redis.useRedis()
      await expect(failed.connect()).rejects.toThrow()
      // v5 can retain the last public status after closing an already-failed
      // socket. Inspect actual cancellation and observe its real connector,
      // rather than inventing an `end` transition or mocking the provider.
      const lifecycle = failed as unknown as {
        manuallyClosing: boolean
        reconnectTimeout: NodeJS.Timeout | null
        stream: { destroyed: boolean }
        connector: { connect: (...args: unknown[]) => unknown }
      }
      const reconnect = vi.spyOn(lifecycle.connector, 'connect')
      const retryDelay = failed.options.retryStrategy?.(1)
      expect(typeof retryDelay).toBe('number')
      if (typeof retryDelay !== 'number' || retryDelay < 0 || retryDelay > 250) {
        throw new Error('bounded_real_retry_strategy_required')
      }
      await redis.closeRedis()
      expect(lifecycle.manuallyClosing).toBe(true)
      expect(lifecycle.reconnectTimeout).toBeNull()
      expect(lifecycle.stream.destroyed).toBe(true)
      const connectsAtClose = reconnect.mock.calls.length
      await new Promise((resolve) => setTimeout(resolve, retryDelay + 25))
      expect(reconnect.mock.calls.length).toBe(connectsAtClose)
      expect(lifecycle.reconnectTimeout).toBeNull()
      reconnect.mockRestore()
      vi.stubEnv('REDIS_URL', fixture.url)
      const recovered = redis.useRedis()
      expect(recovered).not.toBe(failed)
      await recovered.connect()
      expect(await recovered.ping()).toBe('PONG')
      recovered.disconnect()
      await redis.closeRedis()
      await vi.waitFor(() => expect(recovered.status).toBe('end'))
      expect(fixture.failures).toEqual([])
    } finally {
      try {
        await redis.closeRedis()
      } finally {
        await fixture.dispose()
      }
    }
  })
})
