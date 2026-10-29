import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { resolve } from 'node:path'
import { createApp, createError, eventHandler, toNodeListener } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'

// determinism-audit: allow-local-network-harness -- bounded loopback RESP only.
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

function port(server: TcpServer | HttpServer) {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback_address_required')
  return address.port
}
async function listen(server: TcpServer | HttpServer) {
  await new Promise<void>((yes, no) => {
    server.once('error', no)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', no)
      yes()
    })
  })
}
async function close(server: TcpServer | HttpServer) {
  if (!server.listening) return
  await new Promise<void>((yes, no) => server.close((error) => (error ? no(error) : yes())))
}

function decode(buffer: Buffer): { command: string[]; consumed: number } | null {
  const end = buffer.indexOf('\r\n')
  if (end < 0) return null
  if (buffer[0] !== 42) throw new Error('resp_array_required')
  const count = Number(buffer.subarray(1, end).toString())
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('resp_command_bound')
  const command: string[] = []
  let offset = end + 2
  for (let index = 0; index < count; index++) {
    const headerEnd = buffer.indexOf('\r\n', offset)
    if (headerEnd < 0) return null
    if (buffer[offset] !== 36) throw new Error('resp_bulk_required')
    const length = Number(buffer.subarray(offset + 1, headerEnd).toString())
    if (!Number.isInteger(length) || length < 0 || length > 8192) throw new Error('resp_argument_bound')
    offset = headerEnd + 2
    if (buffer.length < offset + length + 2) return null
    command.push(buffer.subarray(offset, offset + length).toString())
    if (buffer.subarray(offset + length, offset + length + 2).toString() !== '\r\n') {
      throw new Error('resp_bulk_terminator')
    }
    offset += length + 2
  }
  return { command, consumed: offset }
}

async function respFixture() {
  const sockets = new Set<Socket>(),
    commands: string[][] = [],
    failures: string[] = []
  let evaluations = 0
  const server = createTcpServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let buffered = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      try {
        buffered = Buffer.concat([buffered, chunk])
        if (buffered.length > 16384) throw new Error('resp_buffer_bound')
        while (true) {
          const parsed = decode(buffered)
          if (!parsed) break
          buffered = buffered.subarray(parsed.consumed)
          commands.push(parsed.command)
          const name = parsed.command[0]!.toUpperCase()
          if (name === 'CLIENT' || name === 'SELECT') socket.write('+OK\r\n')
          else if (name === 'INFO') {
            const info = 'redis_version:7.2.0\r\nloading:0\r\n'
            socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`)
          } else if (name === 'PING') socket.write('+PONG\r\n')
          else if (name === 'EVAL') socket.write(`*2\r\n:${++evaluations}\r\n:59000\r\n`)
          else if (name === 'QUIT') socket.end('+OK\r\n')
          else throw new Error('unexpected_resp_command')
        }
      } catch {
        failures.push('invalid_resp_exchange')
        socket.destroy()
      }
    })
  })
  await listen(server)
  return {
    url: `redis://127.0.0.1:${port(server)}/0`,
    commands,
    failures,
    sockets,
    async dispose() {
      for (const socket of sockets) socket.destroy()
      await close(server)
      expect(sockets.size).toBe(0)
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
    const httpSockets = new Set<Socket>()
    let http: HttpServer | undefined
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
      http = createHttpServer(toNodeListener(app))
      http.on('connection', (socket) => {
        httpSockets.add(socket)
        socket.once('close', () => httpSockets.delete(socket))
      })
      await listen(http)
      const target = `http://127.0.0.1:${port(http)}/`
      const first = await fetch(target)
      expect(first.status).toBe(200)
      expect(first.headers.get('x-ratelimit-remaining')).toBe('0')
      await first.arrayBuffer()
      const second = await fetch(target)
      expect(second.status).toBe(429)
      expect(second.headers.get('retry-after')).toBe('59')
      await second.arrayBuffer()
      const evals = fixture.commands.filter((command) => command[0]!.toUpperCase() === 'EVAL')
      expect(evals).toHaveLength(2)
      expect(evals[0]![1]).toContain("redis.call('PEXPIRE'")
      expect(evals[0]![2]).toBe('1')
      expect(evals[0]![3]).toMatch(/^synthetic-compat:neteco:rate:compatibility:[a-f0-9]{64}$/)
      expect(evals[0]![4]).toBe('60000')
      await redis.closeRedis()
      await vi.waitFor(() => expect(client.status).toBe('end'))
      expect(fixture.commands.filter((command) => command[0]!.toUpperCase() === 'QUIT')).toHaveLength(1)
      expect(fixture.failures).toEqual([])
    } finally {
      try {
        await redis.closeRedis()
      } finally {
        try {
          for (const socket of httpSockets) socket.destroy()
          if (http) await close(http)
        } finally {
          await fixture.dispose()
        }
      }
    }
  })

  it('cleans an unavailable real connection and reconnects with a new singleton', async () => {
    const { redis } = await modules()
    const reserved = createTcpServer()
    await listen(reserved)
    const unavailable = `redis://127.0.0.1:${port(reserved)}/0`
    await close(reserved)
    const fixture = await respFixture()
    try {
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
        stream: Socket
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
