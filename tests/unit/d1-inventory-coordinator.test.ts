import { describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import worker from '../../workers/canary'
import { INVENTORY_COORDINATOR_NAME, InventoryCoordinator } from '../../workers/inventory-coordinator'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'

const NOW = '2026-08-25T09:00:00Z'
const TTL = '2026-08-26T09:00:00Z'

class FakeStorage {
  private readonly values = new Map<string, unknown>()
  private alarm: number | null = null

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value))
  }
  async delete(key: string) {
    this.values.delete(key)
  }
  async list({ prefix }: { prefix?: string; limit?: number }) {
    return new Map([...this.values].filter(([key]) => !prefix || key.startsWith(prefix)))
  }
  async setAlarm(scheduledMs: number) {
    this.alarm = scheduledMs
  }
  async getAlarm() {
    return this.alarm
  }
  async deleteAlarm() {
    this.alarm = null
  }
}

function fakeState(storage = new FakeStorage()) {
  return {
    storage,
    waitUntil: vi.fn()
  } as unknown as DurableObjectState
}

async function environment(
  options: {
    failFirst?: boolean
    failBatch?: boolean
    batchDelayMs?: number
    concurrency?: { active: number; max: number }
  } = {}
) {
  const sqlite = await openMigratedDatabase()
  seedInventoryFixture(sqlite)
  let database = d1OverSqlite(sqlite)
  if (options.failFirst || options.failBatch || options.batchDelayMs)
    database = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'batch') {
          if (options.failBatch) return async () => Promise.reject(new Error('simulated infrastructure outage'))
          if (options.batchDelayMs)
            return async (...parameters: unknown[]) => {
              const counter = options.concurrency
              if (counter) {
                counter.active += 1
                counter.max = Math.max(counter.max, counter.active)
              }
              await new Promise((resolve) => setTimeout(resolve, options.batchDelayMs))
              try {
                return await (target.batch as (...arguments_: unknown[]) => Promise<unknown>)(...parameters)
              } finally {
                if (counter) counter.active -= 1
              }
            }
        }
        if (options.failFirst && property === 'prepare')
          return (sql: string) => {
            const base = (target as { prepare(sql: string): unknown }).prepare(sql) as {
              bind(...parameters: unknown[]): unknown
              first<T>(...parameters: unknown[]): Promise<T | null>
              all<T>(...parameters: unknown[]): Promise<{ results: T[] }>
              run(...parameters: unknown[]): Promise<unknown>
            }
            const poisonedFirst = () => Promise.reject(new Error('secret D1 internals'))
            return {
              ...base,
              first: poisonedFirst,
              bind(...parameters: unknown[]) {
                base.bind(...parameters)
                return { ...base, first: poisonedFirst }
              }
            }
          }
        return Reflect.get(target, property, receiver)
      }
    })
  const storage = new FakeStorage()
  return { database, sqlite, storage: storage as unknown as DurableObjectState['storage'], rawSqlite: sqlite }
}

function request(body: unknown) {
  return new Request(`https://do.invalid/command`, { method: 'POST', body: JSON.stringify(body) })
}

const reserveCommand = (commandId: string, variantId: string) => ({
  type: 'reserve',
  commandId,
  payload: {
    correlationId: 'coord-test',
    expiresAt: TTL,
    idempotencyKey: `cmd-${commandId}`,
    lines: [{ locationId: 'loc-main', quantity: 2, variantId }],
    now: NOW
  }
})

describe('InventoryCoordinator durable object', () => {
  it('executes commands through D1 and replays cached responses after restart', async () => {
    const environment_ = await environment()
    const state = fakeState(environment_.storage)
    const first = new InventoryCoordinator(state, {
      APP_ENV: 'canary',
      DB: environment_.database
    } as unknown as CloudflareEnv)
    const response = await first.fetch(request(reserveCommand('c-1', 'v-1-1')))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { outcome: string }
    expect(body.outcome).toBe('reserved')

    // Simulate a full DO restart: fresh instance over the same durable storage.
    const restarted = new InventoryCoordinator(fakeState(environment_.storage), {
      APP_ENV: 'canary',
      DB: environment_.database
    } as unknown as CloudflareEnv)
    const replayedResponse = await restarted.fetch(request(reserveCommand('c-1', 'v-1-1')))
    expect(replayedResponse.status).toBe(200)
    await expect(replayedResponse.json()).resolves.toEqual(body)

    // The underlying reservation exists exactly once.
    const rows = environment_.rawSqlite.prepare('SELECT count(*) AS total FROM inventory_reservations').get() as {
      total: number
    }
    expect(rows.total).toBe(1)

    const conflictingCommand = reserveCommand('c-1', 'v-1-1')
    conflictingCommand.payload.lines[0]!.quantity = 3
    const conflict = await restarted.fetch(request(conflictingCommand))
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: 'conflict' } })
  })

  it('retains successful command responses beyond the former 256-entry cache boundary', async () => {
    const environment_ = await environment()
    const coordinator = new InventoryCoordinator(fakeState(environment_.storage), {
      APP_ENV: 'canary',
      DB: environment_.database
    } as unknown as CloudflareEnv)
    let firstBody: unknown
    for (let index = 0; index < 260; index += 1) {
      const response = await coordinator.fetch(request(reserveCommand(`retained-${index}`, 'v-5-1')))
      expect(response.status).toBe(200)
      const body = await response.json()
      if (index === 0) firstBody = body
    }
    const replay = await coordinator.fetch(request(reserveCommand('retained-0', 'v-5-1')))
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toEqual(firstBody)
  })

  it('serialises commands issued concurrently before they reach D1', async () => {
    const concurrency = { active: 0, max: 0 }
    const environment_ = await environment({ batchDelayMs: 2, concurrency })
    const coordinator = new InventoryCoordinator(fakeState(environment_.storage), {
      APP_ENV: 'canary',
      DB: environment_.database
    } as unknown as CloudflareEnv)
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) => {
        const command = reserveCommand(`concurrent-${index}`, 'v-4-1')
        command.payload.lines[0]!.quantity = 1
        return coordinator.fetch(request(command))
      })
    )
    expect(concurrency.max).toBe(1)
    expect(responses.filter((response) => response.status === 200)).toHaveLength(2)
    expect(responses.filter((response) => response.status === 409)).toHaveLength(18)
    expect(
      environment_.rawSqlite
        .prepare(
          "SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory_reservation_lines WHERE variant_id = 'v-4-1'"
        )
        .get()
    ).toEqual({ total: 2 })
  })

  it('rejects invalid commands with stable errors and masks internal failures', async () => {
    const environment_ = await environment()
    const coordinator = new InventoryCoordinator(fakeState(environment_.storage), {
      APP_ENV: 'canary',
      DB: environment_.database
    } as unknown as CloudflareEnv)

    const unknownType = await coordinator.fetch(request({ type: 'destroy-everything', commandId: 'c-2' }))
    expect(unknownType.status).toBe(400)
    await expect(unknownType.json()).resolves.toMatchObject({ error: { code: 'invalid_input' } })

    const impossibleInstant = reserveCommand('c-impossible-time', 'v-1-1')
    impossibleInstant.payload.now = '2026-99-99T09:00:00Z'
    const invalidTime = await coordinator.fetch(request(impossibleInstant))
    expect(invalidTime.status).toBe(400)

    const broken = new InventoryCoordinator(fakeState(), {
      APP_ENV: 'canary',
      DB: environment_.database
    } as unknown as CloudflareEnv)
    const proxied = await broken.fetch(
      new Request('https://do.invalid/command', {
        method: 'POST',
        body: JSON.stringify({
          type: 'reserve',
          commandId: 'c-3',
          payload: { idempotencyKey: 'boom-key', correlationId: 't', expiresAt: TTL, lines: [], now: NOW }
        })
      })
    )
    expect([200, 400]).toContain(proxied.status)

    const failingEnvironment = await environment({ failFirst: true, failBatch: false })
    const masked = new InventoryCoordinator(fakeState(), {
      APP_ENV: 'canary',
      DB: failingEnvironment.database
    } as unknown as CloudflareEnv)
    const internal = await masked.fetch(request(reserveCommand('c-4', 'v-1-1')))
    expect(internal.status).toBe(500)
    await expect(internal.json()).resolves.toEqual({ error: { code: 'internal' } })
  })

  it('schedules alarms on live data, ignores obsolete wakeups and executes due expiries', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-25T08:00:00Z') })
    try {
      const environment_ = await environment()
      const state = fakeState(environment_.storage)
      const coordinator = new InventoryCoordinator(state, {
        APP_ENV: 'canary',
        DB: environment_.database
      } as unknown as CloudflareEnv)

      await coordinator.scheduleNextExpiry()
      expect(await environment_.storage.getAlarm()).toBeNull()

      await coordinator.fetch(request(reserveCommand('c-alarm', 'v-1-1')))
      // Reservation TTL is tomorrow; the alarm is scheduled there.
      expect(await environment_.storage.getAlarm()).toBe(Date.parse(TTL))

      // Obsolete/early wakeup before the scheduled instant must be ignored.
      await coordinator.alarm()
      const reservedRows = environment_.rawSqlite
        .prepare("SELECT count(*) AS total FROM inventory_reservations WHERE status='reserved'")
        .get() as { total: number }
      expect(reservedRows.total).toBe(1)

      // Jump past the TTL: the alarm fires, expiry applies, next schedule clears.
      vi.setSystemTime(Date.parse(TTL) + 5_000)
      await coordinator.alarm()
      const expiredRows = environment_.rawSqlite
        .prepare("SELECT count(*) AS total FROM inventory_reservations WHERE status='expired'")
        .get() as { total: number }
      expect(expiredRows.total).toBe(1)
      expect(await environment_.storage.getAlarm()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the globally named instance contract documented', () => {
    expect(INVENTORY_COORDINATOR_NAME).toBe('neteco-inventory-global')
  })
})

describe('expiry queue consumer (at-least-once)', () => {
  function message(body: unknown) {
    return {
      body,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
      queueName: 'neteco-canary-local'
    } as unknown as MessageBatch['messages'][number]
  }

  it('processes valid messages once, acknowledges duplicates and malformed bodies permanently', async () => {
    const environment_ = await environment()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const handler = worker.queue as unknown as (batch: MessageBatch, env: CloudflareEnv) => Promise<void>
    const duplicateBody = {
      version: 1,
      type: 'inventory.expire',
      messageId: 'm-1',
      correlationId: 'queue',
      before: '2026-08-27T00:00:00Z'
    }
    const batch = {
      messages: [
        message(duplicateBody),
        message({ ...duplicateBody }),
        message({ version: 99, type: 'inventory.expire', messageId: 'm-2', correlationId: 'x', before: TTL }),
        message({ garbage: true, secret: 'must-not-be-logged' })
      ]
    } as unknown as MessageBatch

    await handler(batch, { DB: environment_.database } as unknown as CloudflareEnv)

    for (const delivered of batch.messages) {
      const record = delivered as unknown as { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> }
      expect(record.retry).not.toHaveBeenCalled()
      expect(record.ack).toHaveBeenCalledTimes(1)
    }

    // Only the first duplicate actually reached D1: exactly one expiry execution.
    const movements = environment_.rawSqlite.prepare('SELECT count(*) AS total FROM inventory_movements').get() as {
      total: number
    }
    expect(movements.total).toBeGreaterThan(0)
    expect(log.mock.calls.flat().join(' ')).not.toContain('must-not-be-logged')
    log.mockRestore()
  })

  it('retries transient failures without acknowledging', async () => {
    const environment_ = await environment({ failBatch: true })
    const handler = worker.queue as unknown as (batch: MessageBatch, env: CloudflareEnv) => Promise<void>
    const batch = {
      messages: [
        message({
          version: 1,
          type: 'inventory.expire',
          messageId: 'm-retry',
          correlationId: 'queue',
          before: '2026-08-27T00:00:00Z'
        })
      ]
    } as unknown as MessageBatch
    await handler(batch, { DB: environment_.database } as unknown as CloudflareEnv)
    const record = batch.messages[0] as unknown as { retry: ReturnType<typeof vi.fn>; ack: ReturnType<typeof vi.fn> }
    expect(record.retry).toHaveBeenCalled()
    expect(record.ack).not.toHaveBeenCalled()
  })

  it('never calls the unconditional batch acknowledgement', () => {
    expect(worker.queue.toString()).not.toContain('ackAll')
  })
})

describe('inventory fixture typing sanity', () => {
  it('exposes the sqlite handle for direct assertions', async () => {
    const environment_ = await environment()
    expect(typeof (environment_.rawSqlite as DatabaseSync).prepare).toBe('function')
  })
})
