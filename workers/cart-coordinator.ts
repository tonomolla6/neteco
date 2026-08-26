import {
  CartError,
  CartInfrastructureError,
  assertCartAuthorized,
  canonicalPayloadHash,
  createCart,
  expireCart,
  quoteCart,
  setCartLine,
  type QuoteRequestInput,
  type SetLineInput
} from './catalog/cart'

/**
 * CartCoordinator partitions work ONE Durable Object instance PER CART.
 *
 * Partitioning key: `cartDoName(cartId)` maps each cart id to exactly one
 * instance name deterministically (`cart:${cartId}`). Different carts map to
 * different instances and therefore run fully in parallel; every command for
 * the same cart lands on the same instance, which serialises them (maxInFlight
 * = 1 per cart) and makes optimistic-concurrency conflicts impossible to lose.
 *
 * The object stores ONLY successful idempotent command responses (unbounded —
 * replays must survive any number of later commands) and expiry bookkeeping.
 * Cache fingerprints exclude credentials; the cart itself lives in D1 and
 * remains the single source of truth.
 */

export function cartDoName(cartId: string): string {
  if (!cartId || cartId.length > 200) throw new CartError('invalid_input', 'cartId is invalid')
  return `cart:${cartId}`
}

const ALARM_LEEWAY_MS = 1_000

function isValidKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !hasControl(value)
}

function hasControl(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function isCanonicalInstant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
}

export interface CoordinatorDeps {
  database: D1Database
  /** Durable per-command responses; unbounded by design. */
  getResponse: (commandId: string) => Promise<{ payloadHash: string; status: number; body: unknown } | undefined>
  putResponse: (commandId: string, value: { payloadHash: string; status: number; body: unknown }) => Promise<void>
  setAlarm: (atMs: number | null) => Promise<void>
  /** Remembers which cart this instance owns for alarm rescheduling. */
  putAlarmCartId?: (cartId: string) => Promise<void>
}

interface RawCommand {
  type?: unknown
  commandId?: unknown
  cartId?: unknown
  payload?: unknown
}

function parseMutatePayload(payload: unknown): { ok: true; input: SetLineInput } | { ok: false; message: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, message: 'payload must be an object' }
  const raw = payload as Record<string, unknown>
  if (!isValidKey(raw.idempotencyKey)) return { ok: false, message: 'idempotencyKey is invalid' }
  if (!isValidKey(raw.token)) return { ok: false, message: 'token is invalid' }
  if (!isValidKey(raw.correlationId)) return { ok: false, message: 'correlationId is invalid' }
  if (!isCanonicalInstant(raw.now)) return { ok: false, message: 'now must be canonical ISO-8601 UTC' }
  if (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 1)
    return { ok: false, message: 'expectedVersion must be a positive integer' }
  if (!Number.isSafeInteger(raw.quantity) || (raw.quantity as number) < 0 || (raw.quantity as number) > 999)
    return { ok: false, message: 'quantity must be an integer between 0 and 999' }
  return {
    ok: true,
    input: {
      cartId: raw.cartId as string,
      correlationId: raw.correlationId as string,
      expectedVersion: raw.expectedVersion as number,
      idempotencyKey: raw.idempotencyKey as string,
      now: raw.now as string,
      quantity: raw.quantity as number,
      token: raw.token as string,
      variantId: typeof raw.variantId === 'string' ? raw.variantId : ''
    }
  }
}

function parseQuotePayload(payload: unknown): { ok: true; input: QuoteRequestInput } | { ok: false; message: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, message: 'payload must be an object' }
  const raw = payload as Record<string, unknown>
  if (!isValidKey(raw.idempotencyKey)) return { ok: false, message: 'idempotencyKey is invalid' }
  if (!isValidKey(raw.token)) return { ok: false, message: 'token is invalid' }
  if (!isValidKey(raw.correlationId)) return { ok: false, message: 'correlationId is invalid' }
  if (!isCanonicalInstant(raw.now)) return { ok: false, message: 'now must be canonical ISO-8601 UTC' }
  if (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 1)
    return { ok: false, message: 'expectedVersion must be a positive integer' }
  return {
    ok: true,
    input: {
      cartId: raw.cartId as string,
      correlationId: raw.correlationId as string,
      expectedVersion: raw.expectedVersion as number,
      idempotencyKey: raw.idempotencyKey as string,
      now: raw.now as string,
      token: raw.token as string
    }
  }
}

export async function handleCartCommand(
  command: RawCommand,
  deps: CoordinatorDeps
): Promise<{ status: number; body: Record<string, unknown>; rescheduleForCartId?: string }> {
  if (!isValidKey(command.commandId)) return { status: 400, body: { error: { code: 'invalid_input' } } }

  let result: { status: number; body: Record<string, unknown>; rescheduleForCartId?: string }
  let cacheHash: string | null = null
  try {
    switch (command.type) {
      case 'create': {
        if (!isValidKey(command.cartId) || !isCanonicalInstant((command.payload as Record<string, unknown>)?.now))
          return { status: 400, body: { error: { code: 'invalid_input' } } }
        const created = await createCart(deps.database, {
          cartId: command.cartId,
          correlationId: ((command.payload as Record<string, unknown>).correlationId as string) ?? 'api',
          now: (command.payload as Record<string, unknown>).now as string
        })
        result = {
          status: 201,
          body: created as unknown as Record<string, unknown>,
          rescheduleForCartId: created.cartId
        }
        break
      }
      case 'mutate': {
        if (!isValidKey(command.cartId)) return { status: 400, body: { error: { code: 'invalid_input' } } }
        const parsed = parseMutatePayload(command.payload)
        if (!parsed.ok || parsed.input.cartId !== command.cartId)
          return { status: 400, body: { error: { code: 'invalid_input' } } }
        await assertCartAuthorized(deps.database, parsed.input.cartId, parsed.input.token)
        cacheHash = await canonicalPayloadHash({
          cartId: parsed.input.cartId,
          expectedVersion: parsed.input.expectedVersion,
          quantity: parsed.input.quantity,
          type: 'mutate',
          variantId: parsed.input.variantId
        })
        const cached = await deps.getResponse(command.commandId)
        if (cached)
          return cached.payloadHash === cacheHash
            ? { status: cached.status, body: cached.body as Record<string, unknown> }
            : { status: 409, body: { error: { code: 'conflict' } } }
        const outcome = await setCartLine(deps.database, parsed.input)
        const status = outcome.outcome === 'applied' ? 200 : 409
        result = {
          status,
          body: outcome as unknown as Record<string, unknown>,
          rescheduleForCartId: command.cartId as string
        }
        break
      }
      case 'quote': {
        if (!isValidKey(command.cartId)) return { status: 400, body: { error: { code: 'invalid_input' } } }
        const parsed = parseQuotePayload(command.payload)
        if (!parsed.ok || parsed.input.cartId !== command.cartId)
          return { status: 400, body: { error: { code: 'invalid_input' } } }
        await assertCartAuthorized(deps.database, parsed.input.cartId, parsed.input.token)
        cacheHash = await canonicalPayloadHash({
          cartId: parsed.input.cartId,
          expectedVersion: parsed.input.expectedVersion,
          type: 'quote'
        })
        const cached = await deps.getResponse(command.commandId)
        if (cached)
          return cached.payloadHash === cacheHash
            ? { status: cached.status, body: cached.body as Record<string, unknown> }
            : { status: 409, body: { error: { code: 'conflict' } } }
        const outcome = await quoteCart(deps.database, parsed.input)
        const status = outcome.outcome === 'quoted' ? 200 : outcome.outcome === 'empty_cart' ? 422 : 409
        result = { status, body: outcome as unknown as Record<string, unknown> }
        break
      }
      default:
        return { status: 400, body: { error: { code: 'invalid_input' } } }
    }
  } catch (error) {
    if (error instanceof CartInfrastructureError || !(error instanceof CartError))
      return { status: 500, body: { error: { code: 'internal' } } }
    if (error instanceof CartError)
      return {
        status:
          error.code === 'invalid_input'
            ? 400
            : error.code === 'unauthorized'
              ? 401
              : error.code === 'empty_cart'
                ? 422
                : error.code === 'variant_not_available'
                  ? 422
                  : 409,
        body: { error: { code: error.code } }
      }
    // Infrastructure failures are NEVER presented as business outcomes.
    return { status: 500, body: { error: { code: 'internal' } } }
  }

  if (cacheHash && result.status >= 200 && result.status < 300)
    await deps.putResponse(command.commandId, {
      body: result.body,
      payloadHash: cacheHash,
      status: result.status
    })
  if (result.rescheduleForCartId) await scheduleCartExpiry(deps, result.rescheduleForCartId)
  return result
}

/** Schedules THIS cart's expiry alarm from live D1 data; stale alarms are no-ops. */
export async function scheduleCartExpiry(deps: CoordinatorDeps, cartId: string): Promise<void> {
  const row = await deps.database
    .prepare("SELECT expires_at AS due FROM carts WHERE id = ?1 AND status = 'active'")
    .bind(cartId)
    .first<{ due: string }>()
  await deps.setAlarm(row?.due ? Date.parse(row.due) : null)
  await deps.putAlarmCartId?.(cartId)
}

export class CartCoordinator implements DurableObject {
  private serial = Promise.resolve()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CloudflareEnv
  ) {}

  private runSerially<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation)
    this.serial = result.then(
      () => undefined,
      () => undefined
    )
    return result
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

    let outcome: Awaited<ReturnType<typeof handleCartCommand>>
    try {
      outcome = await this.runSerially(() =>
        handleCartCommand(command, {
          database: this.env.DB,
          getResponse: (commandId) => this.state.storage.get(`cmd:${commandId}`),
          putResponse: (commandId, value) => this.state.storage.put(`cmd:${commandId}`, value),
          setAlarm: (atMs) => (atMs === null ? this.state.storage.deleteAlarm() : this.state.storage.setAlarm(atMs)),
          putAlarmCartId: (cartId) => this.state.storage.put('alarmCartId', cartId)
        })
      )
    } catch {
      return Response.json({ error: { code: 'internal' } }, { status: 500 })
    }
    return Response.json(outcome.body, { status: outcome.status })
  }

  /** Expire only this object's cart; a stale alarm is gated by expires_at. */
  async alarm(): Promise<void> {
    const scheduledAt = await this.state.storage.getAlarm()
    if (scheduledAt === null) return
    const cartId = await this.state.storage.get<string>('alarmCartId')
    if (!cartId) {
      await this.state.storage.deleteAlarm()
      return
    }
    if (Date.now() < scheduledAt - ALARM_LEEWAY_MS) {
      await this.state.storage.setAlarm(scheduledAt)
      return
    }
    await expireCart(this.env.DB, {
      cartId,
      at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    })
    // Reschedule only while THIS cart is still alive; otherwise clear.
    await scheduleCartExpiry(this.dependencies(), cartId)
  }

  private dependencies(): CoordinatorDeps {
    return {
      database: this.env.DB,
      getResponse: (commandId) => this.state.storage.get(`cmd:${commandId}`),
      putResponse: (commandId, value) => this.state.storage.put(`cmd:${commandId}`, value),
      setAlarm: (atMs) => (atMs === null ? this.state.storage.deleteAlarm() : this.state.storage.setAlarm(atMs))
    }
  }
}
