import {
  canonicalJson,
  InventoryError,
  assignReservation,
  expireExpiredReservations,
  releaseReservation,
  renewReservation,
  reserveInventory,
  sha256Hex,
  isCanonicalInventoryInstant,
  type OperationInput,
  type ReserveInput
} from './catalog/inventory'

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

/**
 * InventoryCoordinator serialises every inventory mutation through ONE globally
 * named Durable Object instance (`INVENTORY_COORDINATOR_NAME`).
 *
 * Naming rationale: inventory commands are frequently multi-line across
 * variants, so per-variant instances would need cross-instance transactions
 * (deadlock-prone). Command volume is administrative/checkout-scale, far below
 * what a single DO instance can serialise, and a total order over mutations is
 * exactly the property the oversell invariant needs. D1 remains the sole
 * authoritative store: this object caches command responses and schedules
 * expirations, never stock quantities.
 */

export const INVENTORY_COORDINATOR_NAME = 'neteco-inventory-global'

interface StoredResponse {
  commandHash: string
  status: number
  body: unknown
}

function isValidKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !hasControlCharacters(value)
}

function isCanonicalInstant(value: unknown): value is string {
  return isCanonicalInventoryInstant(value)
}

interface RawCommand {
  type?: unknown
  commandId?: unknown
  payload?: unknown
}

interface LinePayload {
  variantId?: unknown
  locationId?: unknown
  quantity?: unknown
}

function parseReservePayload(payload: unknown): { ok: true; input: ReserveInput } | { ok: false; message: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, message: 'payload must be an object' }
  const raw = payload as Record<string, unknown>
  if (!isValidKey(raw.idempotencyKey)) return { ok: false, message: 'idempotencyKey is invalid' }
  if (!isValidKey(raw.correlationId)) return { ok: false, message: 'correlationId is invalid' }
  if (!isCanonicalInstant(raw.now)) return { ok: false, message: 'now must be canonical ISO-8601 UTC' }
  if (!isCanonicalInstant(raw.expiresAt)) return { ok: false, message: 'expiresAt must be canonical ISO-8601 UTC' }
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) return { ok: false, message: 'lines are required' }
  if (raw.reason !== undefined && typeof raw.reason !== 'string')
    return { ok: false, message: 'reason must be a string' }
  const lines = []
  for (const entry of raw.lines as LinePayload[]) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.variantId !== 'string' ||
      typeof entry.locationId !== 'string' ||
      !Number.isSafeInteger(entry.quantity) ||
      (entry.quantity as number) <= 0
    )
      return { ok: false, message: 'each line needs variantId, locationId and a positive integer quantity' }
    lines.push({ locationId: entry.locationId, quantity: entry.quantity as number, variantId: entry.variantId })
  }
  return {
    ok: true,
    input: {
      correlationId: raw.correlationId,
      expiresAt: raw.expiresAt,
      idempotencyKey: raw.idempotencyKey,
      lines,
      now: raw.now,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined
    }
  }
}

function parseOperationPayload(payload: unknown): { ok: true; input: OperationInput } | { ok: false; message: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, message: 'payload must be an object' }
  const raw = payload as Record<string, unknown>
  if (!isValidKey(raw.idempotencyKey)) return { ok: false, message: 'idempotencyKey is invalid' }
  if (!isValidKey(raw.correlationId)) return { ok: false, message: 'correlationId is invalid' }
  if (!isCanonicalInstant(raw.now)) return { ok: false, message: 'now must be canonical ISO-8601 UTC' }
  if (raw.reason !== undefined && typeof raw.reason !== 'string')
    return { ok: false, message: 'reason must be a string' }
  return {
    ok: true,
    input: {
      correlationId: raw.correlationId,
      idempotencyKey: raw.idempotencyKey,
      now: raw.now,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined
    }
  }
}

export interface CoordinatorDependencies {
  database: D1Database
  nowMs: () => number
  setAlarm: (scheduledMs: number) => Promise<void>
}

/** Pure command handler separated from the DO runtime for direct testability. */
export async function handleInventoryCommand(
  command: RawCommand,
  dependencies: CoordinatorDependencies
): Promise<{ status: number; body: Record<string, unknown>; rescheduleAfterSuccess: boolean }> {
  if (!isValidKey(command.commandId))
    return {
      status: 400,
      body: { error: { code: 'invalid_input', message: 'commandId is invalid' } },
      rescheduleAfterSuccess: false
    }

  switch (command.type) {
    case 'reserve': {
      const parsed = parseReservePayload(command.payload)
      if (!parsed.ok)
        return {
          status: 400,
          body: { error: { code: 'invalid_input', message: parsed.message } },
          rescheduleAfterSuccess: false
        }
      const result = await reserveInventory(dependencies.database, parsed.input)
      return {
        status: result.outcome === 'conflict' ? 409 : 200,
        body: result,
        rescheduleAfterSuccess: result.outcome === 'reserved'
      }
    }
    case 'assign':
    case 'release': {
      const parsed = parseOperationPayload(command.payload)
      if (!parsed.ok)
        return {
          status: 400,
          body: { error: { code: 'invalid_input', message: parsed.message } },
          rescheduleAfterSuccess: false
        }
      const result =
        command.type === 'assign'
          ? await assignReservation(dependencies.database, parsed.input)
          : await releaseReservation(dependencies.database, parsed.input)
      const status =
        result.outcome === 'applied' || result.outcome === 'assigned' || result.outcome === 'replayed' ? 200 : 409
      return { status, body: result, rescheduleAfterSuccess: false }
    }
    case 'renew': {
      const parsed = parseOperationPayload(command.payload)
      if (!parsed.ok || !isCanonicalInstant((command.payload as Record<string, unknown>).expiresAt))
        return {
          status: 400,
          body: { error: { code: 'invalid_input', message: parsed.ok ? 'expiresAt is invalid' : parsed.message } },
          rescheduleAfterSuccess: false
        }
      const result = await renewReservation(dependencies.database, {
        ...parsed.input,
        expiresAt: (command.payload as Record<string, unknown>).expiresAt as string
      })
      const status = result.outcome === 'applied' || result.outcome === 'replayed' ? 200 : 409
      return { status, body: result, rescheduleAfterSuccess: result.outcome === 'applied' }
    }
    default:
      return {
        status: 400,
        body: { error: { code: 'invalid_input', message: 'unknown command type' } },
        rescheduleAfterSuccess: false
      }
  }
}

export class InventoryCoordinator implements DurableObject {
  private serial = Promise.resolve()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CloudflareEnv
  ) {}

  private dependencies(): CoordinatorDependencies {
    return {
      database: this.env.DB,
      nowMs: () => Date.now(),
      setAlarm: (scheduledMs) => this.state.storage.setAlarm(scheduledMs)
    }
  }

  private runSerially<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation)
    this.serial = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async cacheResponse(commandId: string, response: StoredResponse) {
    await this.state.storage.put(`cmd:${commandId}`, response)
  }

  /** Schedules the next due-expiry alarm based on live D1 data, bumping the token. */
  async scheduleNextExpiry() {
    const next = await this.env.DB.prepare(
      "SELECT min(expires_at) AS due FROM inventory_reservations WHERE status = 'reserved'"
    ).first<{ due: string | null }>()
    const current = (await this.state.storage.get<{ at: string; token: number }>('alarm')) ?? { at: '', token: 0 }
    const token = current.token + 1
    if (!next?.due) {
      await this.state.storage.put('alarm', { at: '', token })
      await this.state.storage.deleteAlarm()
      return
    }
    await this.state.storage.put('alarm', { at: next.due, token })
    await this.state.storage.setAlarm(Date.parse(next.due))
  }

  /**
   * Alarm handler: ignores obsolete wakeups (token/at superseded or fired
   * before schedule) and always delegates the real decision to the SQL gate on
   * current expires_at, then reschedules.
   */
  async alarm() {
    const scheduled = await this.state.storage.get<{ at: string; token: number }>('alarm')
    if (!scheduled?.at) return
    if (Date.now() < Date.parse(scheduled.at) - 1_000) {
      await this.state.storage.setAlarm(Date.parse(scheduled.at))
      return
    }
    await expireExpiredReservations(this.env.DB, {
      at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      correlationId: `do:${INVENTORY_COORDINATOR_NAME}:${scheduled.token}`
    })
    await this.scheduleNextExpiry()
  }

  private async executeCommand(command: RawCommand): Promise<Response> {
    const commandHash = await sha256Hex(canonicalJson(command))
    if (isValidKey(command.commandId)) {
      const cached = await this.state.storage.get<StoredResponse>(`cmd:${command.commandId}`)
      if (cached) {
        if (cached.commandHash !== commandHash)
          return Response.json(
            { error: { code: 'conflict', message: 'commandId was already used with a different payload' } },
            { status: 409 }
          )
        return Response.json(cached.body, { status: cached.status })
      }
    }
    let outcome: Awaited<ReturnType<typeof handleInventoryCommand>>
    try {
      outcome = await handleInventoryCommand(command, this.dependencies())
    } catch (error) {
      if (error instanceof InventoryError)
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.code === 'invalid_input' ? 400 : error.code === 'not_found' ? 404 : 409 }
        )
      return Response.json({ error: { code: 'internal' } }, { status: 500 })
    }

    if (isValidKey(command.commandId) && outcome.status >= 200 && outcome.status < 300)
      await this.cacheResponse(command.commandId, { commandHash, status: outcome.status, body: outcome.body })
    if (outcome.rescheduleAfterSuccess) await this.scheduleNextExpiry()
    return Response.json(outcome.body, { status: outcome.status })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/command')
      return Response.json({ error: { code: 'not_found' } }, { status: 404 })

    let command: RawCommand
    try {
      command = (await request.json()) as RawCommand
    } catch {
      return Response.json({ error: { code: 'invalid_input', message: 'body must be JSON' } }, { status: 400 })
    }

    return this.runSerially(() => this.executeCommand(command))
  }
}
