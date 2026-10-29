<script setup lang="ts">
import type { z } from 'zod'
import { useCartStore } from '~/stores/cart'
import {
  sharedCartResolveInputSchema,
  sharedCartResolveResponseSchema,
  type SharedCartResolveResponse
} from '~~/shared/cart-snapshots'

definePageMeta({ path: '/carrito/compartido' })
useSeoMeta({ title: 'Carrito compartido', robots: 'noindex, nofollow' })
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
const runtime = useRuntimeConfig()
const { ready, loggedIn, user, session } = useUserSession()
const cart = useCartStore()
const request = useRequestFetch()
const capability = shallowRef<z.infer<typeof sharedCartResolveInputSchema> | null>(null)
const preview = shallowRef<SharedCartResolveResponse | null>(null)
const selected = ref<string[]>([])
const confirmed = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const invalid = ref(false)
const attempted = new Set<string>()
let generation = 0
let disposed = false
const scope = computed(() =>
  JSON.stringify([
    loggedIn.value,
    user.value?.id,
    user.value?.email,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
const allowed = computed(
  // This capability grants only a current public preview, never account access.
  () => runtime.public.serverRuntime === 'cloudflare' && ready.value
)
function purge() {
  generation++
  capability.value = null
  preview.value = null
  selected.value = []
  confirmed.value = false
  error.value = ''
  notice.value = ''
  busy.value = false
  attempted.clear()
  invalid.value = true
}
watch(scope, purge, { flush: 'sync' })
watch(
  allowed,
  (value) => {
    if (!value) purge()
  },
  { flush: 'sync' }
)
watch(
  selected,
  () => {
    confirmed.value = false
  },
  { flush: 'sync', deep: true }
)
if (import.meta.client) {
  const fragment = window.location.hash.slice(1)
  // Do this before a request/render: no bearer in route query, referrer or logs.
  window.history.replaceState(null, '', window.location.pathname)
  const separator = fragment.indexOf('.')
  const parsed = sharedCartResolveInputSchema.safeParse({
    id: fragment.slice(0, separator),
    token: fragment.slice(separator + 1)
  })
  if (separator > 0 && parsed.success) capability.value = parsed.data
  else invalid.value = true
}
const available = computed(() => preview.value?.items.filter((item) => item.available) ?? [])
const candidates = computed(() =>
  available.value.filter((item) => selected.value.includes(item.variantId) && !attempted.has(item.variantId))
)
function current(epoch: number) {
  return !disposed && epoch === generation && allowed.value
}
async function resolve() {
  if (!allowed.value || !capability.value || busy.value || cart.pendingMutation || cart.blockedMutations) return
  const frozen = capability.value,
    epoch = ++generation
  busy.value = true
  error.value = ''
  notice.value = ''
  preview.value = null
  selected.value = []
  confirmed.value = false
  try {
    const parsed = sharedCartResolveResponseSchema.parse(
      await request<unknown>('/api/cart/shared/resolve', {
        method: 'POST',
        body: frozen,
        retry: 0,
        referrerPolicy: 'no-referrer'
      })
    )
    if (!current(epoch) || capability.value !== frozen) return
    if (
      parsed.id !== frozen.id ||
      new Set(parsed.items.map((item) => item.variantId)).size !== parsed.items.length ||
      new Set(parsed.items.filter((item) => item.available).map((item) => item.cartVariantId)).size !==
        parsed.items.filter((item) => item.available).length
    )
      throw new Error('shared_preview_mismatch')
    preview.value = parsed
    selected.value = parsed.items
      .filter((item) => item.available && !attempted.has(item.variantId))
      .map((item) => item.variantId)
  } catch {
    if (current(epoch))
      error.value = 'No se ha podido consultar este enlace. Puede estar caducado, revocado o no disponible.'
  } finally {
    if (epoch === generation) busy.value = false
  }
}
async function copy() {
  if (
    !allowed.value ||
    busy.value ||
    !preview.value ||
    !confirmed.value ||
    !candidates.value.length ||
    cart.pendingMutation ||
    cart.blockedMutations
  )
    return
  const rows = [...candidates.value],
    epoch = generation
  busy.value = true
  error.value = ''
  notice.value = ''
  confirmed.value = false
  let added = 0
  try {
    for (const [index, item] of rows.entries()) {
      if (!current(epoch)) return
      if (cart.pendingMutation || cart.blockedMutations) {
        notice.value = `${added} referencias confirmadas; ${rows.length - index} sin intentar. Revisa el carrito antes de continuar.`
        return
      }
      // Never turn an uncertain ADD into a new key. The cart owns its journal.
      attempted.add(item.variantId)
      try {
        await cart.add({ variantId: item.cartVariantId }, item.quantity)
        added++
      } catch {
        if (current(epoch)) {
          preview.value = null
          selected.value = []
          notice.value = `${added} referencias confirmadas. Una adición tiene resultado incierto; ${rows.length - index - 1} sin intentar. Comprueba la adición en el carrito; esta referencia no se reenviará aquí. Después consulta de nuevo para continuar sólo las nunca intentadas.`
        }
        return
      }
    }
    if (current(epoch)) {
      preview.value = null
      selected.value = []
      notice.value = `${added} referencias confirmadas en tu carrito. El carrito de origen no se ha modificado. Los portes y el precio final se validan al comprar.`
    }
  } finally {
    if (epoch === generation) busy.value = false
  }
}
function unavailableReason(reason: string) {
  return reason === 'quantity_invalid'
    ? 'Cantidad no válida actualmente'
    : reason === 'cart_unmapped'
      ? 'Referencia no habilitada para compra'
      : 'Referencia no disponible actualmente'
}
function money(cents: number) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
}
onBeforeUnmount(() => {
  disposed = true
  purge()
})
</script>

<template>
  <main class="mx-auto min-w-0 max-w-5xl px-4 py-8">
    <h1>Carrito compartido</h1>
    <p class="mt-3">
      Consulta referencias y precios públicos actuales. No es una reserva ni una cotización contractual; no da acceso a
      la cuenta o al carrito original.
    </p>
    <p v-if="runtime.public.serverRuntime !== 'cloudflare'" role="status">
      Los enlaces compartidos no están disponibles en este entorno.
    </p>
    <p v-else-if="invalid" role="alert">Enlace inválido o incompleto. Solicita un nuevo enlace a quien lo compartió.</p>
    <p v-else-if="!allowed" role="status">Espera a confirmar el estado inicial de tu sesión para continuar.</p>
    <template v-else>
      <p v-if="error" role="alert" class="mt-3 break-words">{{ error }}</p>
      <p v-if="notice" role="status" class="mt-3 break-words">{{ notice }}</p>
      <p v-if="busy" role="status">Comprobando…</p>
      <button
        data-shared-resolve
        type="button"
        :disabled="busy || cart.pendingMutation || cart.blockedMutations"
        class="mt-4 rounded border px-3 py-2"
        @click="resolve"
      >
        Consultar referencias actuales
      </button>
      <a href="/carrito" class="ml-3 inline-block underline">Ir a mi carrito</a>
      <p v-if="cart.pendingMutation || cart.blockedMutations" role="status">
        Comprueba primero la adición pendiente en tu carrito. No se enviará ninguna otra referencia.
      </p>
      <div v-if="preview" class="mt-6 min-w-0">
        <p>
          Precios actuales observados; IVA incluido. Las cantidades y la disponibilidad se vuelven a validar al añadir.
        </p>
        <ul class="mt-4 space-y-4">
          <li
            v-for="item in preview.items"
            :key="item.variantId"
            class="min-w-0 rounded border p-3 [overflow-wrap:anywhere]"
          >
            <template v-if="item.available">
              <label class="flex min-w-0 items-start gap-3">
                <input
                  v-model="selected"
                  type="checkbox"
                  :value="item.variantId"
                  :disabled="busy || attempted.has(item.variantId)"
                  :aria-label="`Seleccionar ${item.name}`"
                />
                <span
                  >{{ item.name }} · {{ item.sku }} · {{ item.format }}<br />{{ item.quantity }} {{ item.unitLabel }} ·
                  {{ money(item.unitGrossCents) }} por unidad · {{ money(item.grossCents) }} total (IVA
                  {{ money(item.taxCents) }})</span
                >
              </label>
              <p v-if="attempted.has(item.variantId)" class="mt-2">
                Referencia ya intentada. Revisa su resultado en tu carrito; no se reenviará desde este enlace.
              </p>
            </template>
            <p v-else>{{ item.quantity }} unidades solicitadas: {{ unavailableReason(item.reason) }}.</p>
          </li>
        </ul>
        <label v-if="candidates.length" class="mt-4 flex items-start gap-2"
          ><input v-model="confirmed" data-shared-confirm type="checkbox" :disabled="busy" /><span
            >Confirmo añadir las referencias seleccionadas a mi carrito con validación actual.</span
          ></label
        >
        <button
          data-shared-copy
          type="button"
          :disabled="busy || !confirmed || !candidates.length || cart.pendingMutation || cart.blockedMutations"
          class="mt-3 rounded border px-3 py-2"
          @click="copy"
        >
          Añadir selección a mi carrito
        </button>
      </div>
    </template>
  </main>
</template>
