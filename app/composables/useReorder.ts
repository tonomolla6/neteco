import { useCartStore } from '~/stores/cart'
import type { OrderDetailLines, OrderLine } from './useAccount'
import { readOrderDetail } from '../utils/orderDetail'

/**
 * Flujo de «volver a pedir».
 *
 * Pide el contenido del pedido al servidor (solo lectura), lo enseña al cliente para que
 * confirme —incluyendo qué referencias ya no están disponibles y por qué— y solo entonces
 * añade las líneas al carrito con el flujo normal, que es el que valida stock, mínimos,
 * incrementos y precio vigente.
 *
 * No añade nada sin confirmación: el precio o la disponibilidad pueden haber cambiado desde
 * el pedido original, y meterlo al carrito a espaldas del cliente sería exactamente el
 * patrón oscuro que este rediseño evita.
 */
export function useReorder() {
  const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
  const eligible = (line: OrderLine) =>
    line.available && (line.reorderOffer === undefined || line.reorderOffer?.purchasable === true)
  const plan = ref<OrderDetailLines | null>(null)
  const loading = ref(false)
  const adding = ref(false)
  const error = ref('')
  const readFailed = ref(false)
  let readPath: string | null = null
  let pending: number | null = null
  let generation = 0
  let disposed = false
  let flight = false
  type IntentLine = Readonly<{ index: number; variantId: number; quantity: number; name: string }>
  let intent: ReadonlyArray<IntentLine> = []
  const outcomes = ref<Record<number, 'added' | 'uncertain'>>({})
  const authorityBlocked = ref(false)
  const { loggedIn, user, session } = useUserSession()
  const identity = computed(() =>
    JSON.stringify([loggedIn.value, user.value?.id, session.value?.sessionId, session.value?.sessionVersion])
  )

  const availableLines = computed(() =>
    authorityBlocked.value
      ? []
      : (plan.value?.lines.filter((line, index) => eligible(line) && !outcomes.value[index]) ?? [])
  )
  const unavailableLines = computed(() => plan.value?.lines.filter((line) => !eligible(line)) ?? [])
  function unavailableReason(line: OrderLine) {
    if (line.reason) return line.reason
    if (line.reorderOffer === null) return 'No hay una oferta vigente confirmada.'
    if (line.reorderOffer && !line.reorderOffer.quantityAllowed)
      return 'La cantidad histórica no cumple los límites vigentes.'
    if (line.reorderOffer) return 'La disponibilidad observada no permite añadir esta cantidad.'
    return 'No disponible ahora mismo.'
  }
  const canRetry = computed(() => readFailed.value && !loading.value && !plan.value)
  const addedCount = computed(() => Object.values(outcomes.value).filter((value) => value === 'added').length)

  async function read(path: string) {
    if (disposed || pending !== null || flight || !loggedIn.value) return
    const request = ++generation
    pending = request
    loading.value = true
    readFailed.value = false
    error.value = ''
    plan.value = null
    intent = []
    outcomes.value = {}
    authorityBlocked.value = false
    try {
      const raw = await $fetch<unknown>(path, { method: 'GET' })
      if (disposed || request !== generation) return
      const result = readOrderDetail(raw, decodeURIComponent(path.slice('/api/orders/'.length, -'/lines'.length)))
      if (!result || (cloudflare && result.lines.some((line) => line.reorderOffer === undefined)))
        throw new Error('unconfirmed_order_detail')
      plan.value = result
      intent = Object.freeze(
        result.lines.flatMap((line, index) =>
          eligible(line)
            ? [Object.freeze({ index, variantId: line.variantId!, quantity: line.quantity, name: line.name })]
            : []
        )
      )
    } catch {
      if (disposed || request !== generation) return
      readFailed.value = true
      error.value = 'No hemos podido preparar la repetición del pedido. Puedes volver a intentarlo.'
    } finally {
      if (request === generation) {
        pending = null
        loading.value = false
      }
    }
  }

  async function open(orderId: string) {
    if (disposed || pending !== null || flight || !loggedIn.value) return
    // Public numbers in Node and UUIDs in D1 are both opaque identities. Keep
    // them exact and encode one path segment; never coerce a query/array/object.
    if (
      typeof orderId !== 'string' ||
      !orderId ||
      orderId.trim() !== orderId ||
      [...orderId].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      return
    let path: string
    try {
      path = `/api/orders/${encodeURIComponent(orderId)}/lines`
    } catch {
      return
    }
    readPath = path
    await read(path)
  }

  async function retry() {
    if (disposed || pending !== null || !readFailed.value || !readPath) return
    await read(readPath)
  }

  function close() {
    ++generation
    pending = null
    readPath = null
    loading.value = false
    readFailed.value = false
    plan.value = null
    intent = []
    outcomes.value = {}
    authorityBlocked.value = false
    error.value = ''
  }

  watch(identity, close, { flush: 'sync' })

  onBeforeUnmount(() => {
    disposed = true
    close()
  })

  /** Añade las líneas disponibles y devuelve cuántas entraron y cuántas fallaron. */
  async function confirm() {
    const empty = { added: 0, failed: [] as string[] }
    if (disposed || flight || pending !== null || !plan.value || !loggedIn.value || authorityBlocked.value) return empty
    const cart = useCartStore()
    const pendingCartMessage =
      'Comprueba el carrito y resuelve la adición pendiente antes de confirmar las líneas restantes.'
    if (cart.pendingMutation) {
      error.value = pendingCartMessage
      return empty
    }
    const lines = intent.filter((line) => !outcomes.value[line.index])
    if (!lines.length) return empty
    const request = generation,
      owner = identity.value
    const current = () => !disposed && generation === request && identity.value === owner
    flight = true
    adding.value = true
    error.value = ''
    let added = 0
    let cartBlocked = false
    const failed: string[] = []
    try {
      for (const line of lines) {
        if (!current()) break
        if (cart.pendingMutation) {
          cartBlocked = true
          break
        }
        try {
          await cart.add({ variantId: line.variantId! } as never, line.quantity)
          if (!current()) break
          outcomes.value = { ...outcomes.value, [line.index]: 'added' }
          added += 1
        } catch (failure: unknown) {
          if (!current()) break
          failed.push(line.name)
          const status =
            failure && typeof failure === 'object'
              ? ((failure as { statusCode?: number; status?: number }).statusCode ??
                (failure as { status?: number }).status)
              : undefined
          if (status === 401 || status === 403) {
            authorityBlocked.value = true
            plan.value = null
            intent = []
            error.value = 'Tu sesión ya no permite continuar. Comprueba el carrito y vuelve a iniciar sesión.'
            break
          }
          // Reorder has no confirmed receipt for this attempt. The cart owns
          // reconciliation; even after it resolves, never resend this line here.
          if (![400, 422].includes(status ?? 0)) outcomes.value = { ...outcomes.value, [line.index]: 'uncertain' }
          // The store retains the original ADD/key for explicit recovery. Do
          // not submit the remaining lines or label never-sent lines uncertain.
          if (cart.pendingMutation) {
            cartBlocked = true
            break
          }
        }
      }
    } finally {
      flight = false
      adding.value = false
    }
    if (!current()) return empty
    const uncertainNames = intent.filter((line) => outcomes.value[line.index] === 'uncertain').map((line) => line.name)
    if (failed.length || uncertainNames.length) {
      if (!authorityBlocked.value)
        error.value = uncertainNames.length
          ? `No se ha confirmado la adición: ${uncertainNames.join(', ')}. Comprueba el carrito antes de repetir el pedido; no volveremos a enviar esas líneas.${failed.filter((name) => !uncertainNames.includes(name)).length ? ` No se han podido añadir: ${failed.filter((name) => !uncertainNames.includes(name)).join(', ')}.` : ''}`
          : `No se han podido añadir: ${failed.join(', ')}.`
    } else if (cartBlocked) {
      error.value = pendingCartMessage
    } else if (!Object.values(outcomes.value).includes('uncertain')) {
      plan.value = null
      intent = []
    }
    return { added, failed }
  }

  return {
    plan,
    loading,
    adding,
    error,
    canRetry,
    addedCount,
    availableLines,
    unavailableLines,
    unavailableReason,
    open,
    close,
    retry,
    confirm
  }
}
