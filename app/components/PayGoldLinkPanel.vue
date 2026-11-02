<script setup lang="ts">
import { z } from 'zod'
const props = defineProps<{
  receipt: { action: string; quoteId: string; orderId: string | null; version: number } | null
}>()
const request = useRequestFetch(),
  auth = useUserSession()
const uuid = z.string().uuid(),
  instant = z.string().datetime({ offset: false })
const quoteSchema = z
  .object({
    id: uuid,
    version: z.number().int().positive(),
    status: z.literal('converted'),
    orderId: uuid,
    validUntil: instant,
    total: z.object({ grossCents: z.number().int().safe().positive() }).passthrough()
  })
  .passthrough()
const orderSchema = z
  .object({
    id: uuid,
    orderStatus: z.literal('awaiting_payment'),
    inventoryStatus: z.literal('reserved'),
    reservationExpiresAt: instant,
    total: z.number().int().safe().positive()
  })
  .passthrough()
const resultSchema = z
  .object({
    quoteId: uuid,
    orderId: uuid,
    paymentIntentId: uuid,
    amountCents: z.number().int().safe().positive(),
    expiresAt: instant,
    url: z.string().url().max(2048)
  })
  .strict()
const receiptSchema = z
  .object({ action: z.literal('convert'), quoteId: uuid, orderId: uuid, version: z.number().int().safe().positive() })
  .passthrough()
const attemptSchema = z
  .object({
    quoteId: uuid,
    orderId: uuid,
    expectedVersion: z.number().int().safe().positive(),
    expiresAt: instant,
    commandId: uuid
  })
  .strict()
const scope = computed(() =>
  JSON.stringify([
    auth.user.value?.id,
    auth.session.value?.sessionId,
    auth.session.value?.sessionVersion,
    auth.loggedIn.value
  ])
)
const manualReceipt = ref<{ action: 'convert'; quoteId: string; orderId: string; version: number } | null>(null)
const selectedReceipt = computed(() => manualReceipt.value ?? props.receipt)
const target = computed(() => JSON.stringify(selectedReceipt.value))
const quoteInput = ref('')
let recoverSelected = false
const loading = ref(false),
  busy = ref(false),
  error = ref(''),
  link = ref('')
const verified = ref<{
  quoteId: string
  orderId: string
  version: number
  amount: number
  validUntil: string
  reservationExpiresAt: string
} | null>(null)
const pending = ref<{
  quoteId: string
  orderId: string
  expectedVersion: number
  expiresAt: string
  commandId: string
} | null>(null)
let epoch = 0,
  mounted = false
const current = (generation: number, identity: string, selected: string) =>
  mounted && generation === epoch && identity === scope.value && selected === target.value
async function refresh() {
  const parsed = receiptSchema.safeParse(selectedReceipt.value)
  if (!parsed.success) return
  const generation = epoch,
    identity = scope.value,
    selected = target.value
  loading.value = true
  error.value = ''
  verified.value = null
  try {
    const [rawQuote, rawOrder] = await Promise.all([
      request(`/api/account/sales-quotes/${parsed.data.quoteId}`, { cache: 'no-store', retry: 0 }),
      request(`/api/orders/${parsed.data.orderId}`, { cache: 'no-store', retry: 0 })
    ])
    if (!current(generation, identity, selected)) return
    const quote = quoteSchema.parse(rawQuote),
      order = orderSchema.parse(rawOrder)
    if (
      quote.id !== parsed.data.quoteId ||
      quote.orderId !== parsed.data.orderId ||
      quote.version !== parsed.data.version ||
      order.id !== parsed.data.orderId ||
      quote.total.grossCents !== order.total ||
      Math.min(Date.parse(quote.validUntil), Date.parse(order.reservationExpiresAt)) <= Date.now() + 5000
    )
      throw new Error('stale')
    verified.value = {
      quoteId: quote.id,
      orderId: order.id,
      version: quote.version,
      amount: order.total,
      validUntil: quote.validUntil,
      reservationExpiresAt: order.reservationExpiresAt
    }
    if (recoverSelected) {
      const params = new URLSearchParams({ quoteId: quote.id, orderId: order.id })
      const raw = z
        .object({ attempt: attemptSchema.nullable() })
        .strict()
        .parse(await request(`/api/account/paygold-links/recover?${params}`, { cache: 'no-store', retry: 0 }))
      if (!current(generation, identity, selected)) return
      if (
        raw.attempt &&
        (raw.attempt.quoteId !== quote.id ||
          raw.attempt.orderId !== order.id ||
          raw.attempt.expectedVersion !== quote.version ||
          Date.parse(raw.attempt.expiresAt) <= Date.now() ||
          Date.parse(raw.attempt.expiresAt) >
            Math.min(Date.parse(quote.validUntil), Date.parse(order.reservationExpiresAt)))
      )
        throw new Error('stale attempt')
      pending.value = raw.attempt
    }
  } catch {
    if (current(generation, identity, selected)) {
      verified.value = null
      error.value = 'No hemos podido verificar el pedido y su reserva. Vuelve a comprobarlos.'
    }
  } finally {
    if (current(generation, identity, selected)) loading.value = false
  }
}
async function openQuote() {
  const parsed = uuid.safeParse(quoteInput.value.trim())
  if (!parsed.success || loading.value || busy.value) {
    error.value = 'Introduce el identificador del presupuesto.'
    return
  }
  const generation = ++epoch,
    identity = scope.value,
    id = parsed.data
  loading.value = true
  error.value = ''
  link.value = ''
  verified.value = null
  pending.value = null
  try {
    const quote = quoteSchema.parse(await request(`/api/account/sales-quotes/${id}`, { cache: 'no-store', retry: 0 }))
    if (!mounted || generation !== epoch || identity !== scope.value || quoteInput.value.trim() !== id) return
    if (quote.id !== id) throw new Error('wrong quote')
    recoverSelected = true
    const previousTarget = target.value
    manualReceipt.value = { action: 'convert', quoteId: id, orderId: quote.orderId, version: quote.version }
    if (target.value === previousTarget) void refresh()
  } catch {
    if (mounted && generation === epoch && identity === scope.value)
      error.value = 'No hemos podido abrir el presupuesto convertido.'
  } finally {
    if (mounted && generation === epoch && identity === scope.value) loading.value = false
  }
}
async function issue() {
  if (busy.value || !verified.value) return
  const item = verified.value
  if (!pending.value) {
    const expiry =
      Math.min(Date.parse(item.validUntil), Date.parse(item.reservationExpiresAt), Date.now() + 300000) - 2000
    if (expiry <= Date.now() + 1000) {
      error.value = 'La reserva ha caducado. Vuelve a comprobar el pedido.'
      return
    }
    pending.value = {
      quoteId: item.quoteId,
      orderId: item.orderId,
      expectedVersion: item.version,
      expiresAt: new Date(expiry).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      commandId: crypto.randomUUID()
    }
  }
  const command = pending.value,
    generation = epoch,
    identity = scope.value,
    selected = target.value
  busy.value = true
  error.value = ''
  try {
    const result = resultSchema.parse(
      await request<unknown, string>('/api/account/paygold-links', {
        method: 'POST',
        headers: { 'Idempotency-Key': command.commandId },
        body: command,
        cache: 'no-store',
        retry: 0
      })
    )
    if (!current(generation, identity, selected)) return
    const url = new URL(result.url)
    if (
      result.quoteId !== command.quoteId ||
      result.orderId !== command.orderId ||
      result.amountCents !== item.amount ||
      result.expiresAt !== command.expiresAt ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('invalid receipt')
    link.value = url.href
    pending.value = null
  } catch {
    if (current(generation, identity, selected))
      error.value = 'No hemos podido confirmar el enlace. Vuelve a intentarlo para comprobar el mismo comando.'
  } finally {
    if (current(generation, identity, selected)) busy.value = false
  }
}
// A quote typed for one account must never survive into another account's session.
watch(scope, () => {
  quoteInput.value = ''
  manualReceipt.value = null
  recoverSelected = false
})
watch([scope, target], () => {
  epoch++
  loading.value = false
  busy.value = false
  error.value = ''
  link.value = ''
  verified.value = null
  pending.value = null
  if (mounted) void refresh()
})
watch(
  () => props.receipt,
  () => {
    manualReceipt.value = null
    recoverSelected = false
  }
)
onMounted(() => {
  mounted = true
  void refresh()
})
onBeforeUnmount(() => {
  mounted = false
  epoch++
})
</script>
<template>
  <section aria-labelledby="paygold-title">
    <h2 id="paygold-title">Enlace de pago</h2>
    <p v-if="!selectedReceipt">Crea un pedido a partir de un presupuesto para solicitar un enlace.</p>
    <form v-if="!receipt" @submit.prevent="openQuote">
      <label for="paygold-quote">Identificador del presupuesto convertido</label>
      <input id="paygold-quote" v-model="quoteInput" autocomplete="off" />
      <button type="submit" :disabled="loading || busy">Abrir presupuesto</button>
    </form>
    <p v-if="loading" role="status">Comprobando el pedido y su reserva…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="selectedReceipt && error && !verified && !loading" type="button" @click="refresh">
      Volver a comprobar
    </button>
    <button
      v-if="verified && !link"
      data-testid="paygold-issue"
      type="button"
      :disabled="busy || loading"
      @click="issue"
    >
      {{ pending ? 'Volver a comprobar' : 'Generar enlace de pago' }}
    </button>
    <p v-if="busy" role="status">Solicitando el enlace…</p>
    <p v-if="link">Enlace de pago: <a :href="link" target="_blank" rel="noopener noreferrer">Abrir enlace seguro</a></p>
  </section>
</template>
