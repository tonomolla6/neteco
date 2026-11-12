<script setup lang="ts">
import { z } from 'zod'
import { useCartStore } from '~/stores/cart'
import {
  cartSnapshotInputSchema,
  cartSnapshotListSchema,
  cartSnapshotResponseSchema,
  cartSnapshotCommandSchema,
  cartSnapshotRevokeReceiptSchema,
  cartSnapshotIntentHash,
  cartSnapshotRevokeIntentHash,
  type CartSnapshotInput,
  type CartSnapshotReceipt,
  type CartSnapshotRevokeReceipt,
  type CartSnapshotList,
  type CartSnapshotResponse
} from '~~/shared/cart-snapshots'

const emit = defineEmits<{ pending: [boolean] }>()
const runtime = useRuntimeConfig()
const { ready, loggedIn, user, session } = useUserSession()
const cart = useCartStore()
const request = useRequestFetch()
const root = '/api/account/cart-snapshots'
const name = ref('')
const entries = shallowRef<CartSnapshotList['items']>([])
const readState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const error = ref('')
const notice = ref('')
const busy = ref(false)
const denied = ref(false)
const capability = shallowRef<CartSnapshotResponse['share']>(null)
type Intent = {
  action: 'create' | 'revoke'
  key: string
  hash: string
  body: CartSnapshotInput | Record<string, never>
  shareId?: string
  cartId: string | null
}
const intent = shallowRef<Intent | null>(null)
let generation = 0
let disposed = false
let reading = false
const scope = computed(() =>
  JSON.stringify([
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.email,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
const authorized = computed(
  () =>
    runtime.public.serverRuntime === 'cloudflare' &&
    ready.value &&
    loggedIn.value &&
    user.value?.emailVerified === true &&
    z.string().uuid().safeParse(user.value?.id).success &&
    z.string().email().safeParse(user.value?.email).success &&
    z.string().uuid().safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    Number(session.value?.sessionVersion) >= 1 &&
    !denied.value
)
const canSave = computed(
  () =>
    authorized.value &&
    readState.value === 'ready' &&
    !busy.value &&
    !intent.value &&
    cart.ready &&
    !cart.loading &&
    !cart.error &&
    cart.items.length > 0 &&
    !cart.pendingMutation &&
    !cart.blockedMutations
)
function purge() {
  generation++
  name.value = ''
  entries.value = []
  readState.value = 'idle'
  error.value = ''
  notice.value = ''
  capability.value = null
  intent.value = null
  busy.value = false
  reading = false
  emit('pending', false)
}
watch(
  scope,
  () => {
    denied.value = false
    purge()
  },
  { flush: 'sync' }
)
watch(
  authorized,
  (value) => {
    if (!value) purge()
  },
  { flush: 'sync' }
)
watch(intent, (value) => emit('pending', value !== null), { flush: 'sync' })
function current(epoch: number) {
  return !disposed && epoch === generation && authorized.value
}
function reject(errorInput: unknown) {
  const status =
    (errorInput as { statusCode?: number; status?: number })?.statusCode ?? (errorInput as { status?: number })?.status
  if (status === 401 || status === 403) {
    denied.value = true
    purge()
    return true
  }
  return false
}
async function refresh() {
  if (!authorized.value || reading || busy.value) return false
  reading = true
  const epoch = generation
  readState.value = 'loading'
  error.value = ''
  try {
    const parsed = cartSnapshotListSchema.parse(await request(root, { retry: 0, referrerPolicy: 'no-referrer' }))
    if (!current(epoch)) return false
    entries.value = parsed.items
    readState.value = 'ready'
    return true
  } catch (failure) {
    if (current(epoch) && !reject(failure)) {
      entries.value = []
      readState.value = 'error'
      error.value = 'No se han podido consultar los carritos guardados.'
    }
    return false
  } finally {
    if (epoch === generation) reading = false
  }
}
function matches(receipt: CartSnapshotReceipt | CartSnapshotRevokeReceipt, frozen: Intent) {
  return (
    receipt.commandId === frozen.key &&
    receipt.payloadHash === frozen.hash &&
    (frozen.action === 'create'
      ? 'cartVersion' in receipt &&
        receipt.cartVersion === (frozen.body as CartSnapshotInput).expectedCartVersion &&
        (receipt.shareId !== null) === (frozen.body as CartSnapshotInput).createShare
      : receipt.shareId === frozen.shareId)
  )
}
async function confirmReceipt(
  receipt: CartSnapshotReceipt | CartSnapshotRevokeReceipt,
  share: CartSnapshotResponse['share'],
  frozen: Intent,
  epoch: number
) {
  if (!matches(receipt, frozen)) throw new Error('receipt_mismatch')
  const list = cartSnapshotListSchema.parse(await request(root, { retry: 0, referrerPolicy: 'no-referrer' }))
  if (!current(epoch) || intent.value !== frozen) return
  const row = list.items.find((item) =>
    frozen.action === 'create'
      ? item.receipt.commandId === frozen.key &&
        item.receipt.payloadHash === frozen.hash &&
        item.receipt.listId === (receipt as CartSnapshotReceipt).listId
      : item.receipt.shareId === frozen.shareId
  )
  // A historical applied command is not proof that a deleted list/link is live.
  if (frozen.action === 'revoke' && row && !row.revoked) throw new Error('revocation_unconfirmed')
  entries.value = list.items
  readState.value = 'ready'
  capability.value = frozen.action === 'create' && row && !row.revoked ? share : null
  intent.value = null
  name.value = ''
  error.value = ''
  notice.value =
    frozen.action === 'revoke'
      ? 'Enlace revocado y confirmado.'
      : !row
        ? 'La operación original está confirmada; la lista se eliminó después. No se ha vuelto a crear.'
        : row.revoked
          ? 'La operación original está confirmada; el enlace fue revocado. No se ha vuelto a activar.'
          : 'Lista guardada y confirmada. El enlace original, si existe, no garantiza vigencia: puede caducar o revocarse.'
}
async function send(frozen: Intent, epoch: number) {
  if (!current(epoch) || intent.value !== frozen) return
  const headers: Record<string, string> = { 'Idempotency-Key': frozen.key }
  if (frozen.action === 'create') {
    if (!frozen.cartId || cart.id !== frozen.cartId) {
      error.value = 'El carrito cambió. No se ha reenviado la operación del carrito original.'
      busy.value = false
      return
    }
    headers['X-Neteco-Cart-Id'] = frozen.cartId
  }
  try {
    const raw = await request<unknown>(frozen.action === 'create' ? root : `${root}/${frozen.shareId}/revoke`, {
      method: 'POST',
      body: frozen.body,
      headers,
      retry: 0,
      referrerPolicy: 'no-referrer'
    })
    if (!current(epoch) || intent.value !== frozen) return
    if (frozen.action === 'create') {
      const parsed = cartSnapshotResponseSchema.parse(raw)
      await confirmReceipt(parsed.receipt, parsed.share, frozen, epoch)
    } else await confirmReceipt(cartSnapshotRevokeReceiptSchema.parse(raw), null, frozen, epoch)
  } catch (failure) {
    if (current(epoch) && !reject(failure))
      error.value = 'Resultado incierto. Comprueba la operación original; no se ha reenviado automáticamente.'
  } finally {
    if (epoch === generation) busy.value = false
  }
}
async function save(createShare: boolean) {
  if (!canSave.value) return
  const cartId = cart.id,
    expectedCartVersion = cart.version
  if (!cartId) return
  const parsed = cartSnapshotInputSchema.safeParse({ name: name.value, expectedCartVersion, createShare })
  if (!parsed.success) {
    error.value = 'Escribe un nombre válido de hasta 80 caracteres.'
    return
  }
  busy.value = true
  capability.value = null
  error.value = ''
  notice.value = ''
  const epoch = generation
  try {
    const frozen: Intent = {
      action: 'create',
      key: crypto.randomUUID(),
      hash: await cartSnapshotIntentHash(parsed.data),
      body: parsed.data,
      cartId
    }
    if (!current(epoch)) return
    if (cart.id !== cartId || cart.version !== expectedCartVersion || cart.pendingMutation || cart.blockedMutations) {
      error.value =
        'El carrito cambió durante la preparación. Revisa su contenido antes de guardar; no se ha enviado ninguna operación.'
      return
    }
    intent.value = frozen
    await send(frozen, epoch)
  } finally {
    if (epoch === generation) busy.value = false
  }
}
async function revoke(shareId: string) {
  if (
    !authorized.value ||
    busy.value ||
    intent.value ||
    !entries.value.some((row) => row.receipt.shareId === shareId && !row.revoked)
  )
    return
  busy.value = true
  capability.value = null
  error.value = ''
  notice.value = ''
  const epoch = generation
  try {
    const frozen: Intent = {
      action: 'revoke',
      key: crypto.randomUUID(),
      hash: await cartSnapshotRevokeIntentHash(shareId, {}),
      body: {},
      shareId,
      cartId: null
    }
    if (!current(epoch)) return
    intent.value = frozen
    await send(frozen, epoch)
  } finally {
    if (epoch === generation) busy.value = false
  }
}
async function check() {
  const frozen = intent.value
  if (!frozen || !authorized.value || busy.value) return
  const headers: Record<string, string> = { 'X-Neteco-Command-Payload-Hash': frozen.hash }
  if (frozen.action === 'create') {
    if (!frozen.cartId) return
    headers['X-Neteco-Cart-Id'] = frozen.cartId
  }
  busy.value = true
  const epoch = generation
  try {
    const result = cartSnapshotCommandSchema.parse(
      await request(`${root}/commands/${frozen.key}`, {
        headers,
        retry: 0,
        referrerPolicy: 'no-referrer'
      })
    )
    if (!current(epoch) || intent.value !== frozen) return
    if (result.outcome === 'unknown') {
      error.value = 'Resultado incierto. El recibo desconocido no demuestra ausencia de la operación.'
      return
    }
    if (result.action !== frozen.action) throw new Error('action_mismatch')
    await confirmReceipt(result.receipt, result.share, frozen, epoch)
  } catch (failure) {
    if (current(epoch) && !reject(failure))
      error.value = 'Resultado incierto. No se ha podido confirmar la operación original.'
  } finally {
    if (epoch === generation) busy.value = false
  }
}
async function retry() {
  const frozen = intent.value
  if (!frozen || !authorized.value || busy.value || (frozen.action === 'create' && cart.id !== frozen.cartId)) return
  busy.value = true
  await send(frozen, generation)
}
async function copyLink() {
  if (!authorized.value || !capability.value || busy.value || !import.meta.client) return
  const epoch = generation,
    share = capability.value
  try {
    await navigator.clipboard.writeText(`${window.location.origin}/carrito/compartido#${share.id}.${share.token}`)
    if (current(epoch))
      notice.value = 'Enlace original copiado. Caduca en 24 horas desde su creación y puede haber sido revocado.'
  } catch {
    if (current(epoch)) error.value = 'No se ha podido copiar el enlace; revisa el permiso del portapapeles.'
  }
}
onMounted(() => {
  if (authorized.value) void refresh()
})
onBeforeUnmount(() => {
  disposed = true
  purge()
})
</script>

<template>
  <section
    v-if="authorized"
    aria-label="Guardar y compartir carrito"
    class="mt-6 min-w-0 rounded-xl border border-slate-200 p-4"
  >
    <h2 class="font-semibold">Guardar y compartir carrito</h2>
    <p class="mt-2 text-sm">
      Guarda las cantidades como una nueva lista de compra. Compartir es opcional; el enlace permite consultar
      referencias durante 24 horas, no tu cuenta ni tu carrito.
    </p>
    <p v-if="error" role="alert" class="mt-3 break-words">{{ error }}</p>
    <p v-if="notice" role="status" class="mt-3 break-words">{{ notice }}</p>
    <p v-if="readState === 'loading'" role="status">Consultando carritos guardados…</p>
    <button
      data-snapshot-refresh
      type="button"
      :disabled="busy || readState === 'loading'"
      class="mt-3 underline"
      @click="refresh"
    >
      Actualizar guardados
    </button>
    <p v-if="readState === 'ready' && entries.length === 0" class="mt-3">Todavía no has guardado ningún carrito.</p>
    <ul v-if="readState === 'ready'" class="mt-3 space-y-3">
      <li v-for="row in entries" :key="row.receipt.commandId" class="flex min-w-0 flex-wrap items-center gap-3">
        <span
          >Lista guardada <time :datetime="row.receipt.createdAt">{{ row.receipt.createdAt }}</time></span
        >
        <span v-if="row.receipt.shareId">{{
          row.revoked ? 'Enlace revocado' : 'Enlace original; puede haber caducado'
        }}</span>
        <button
          v-if="row.receipt.shareId && !row.revoked"
          :data-snapshot-revoke="row.receipt.shareId"
          type="button"
          :disabled="busy || !!intent"
          class="underline"
          @click="revoke(row.receipt.shareId)"
        >
          Revocar enlace
        </button>
      </li>
    </ul>
    <a href="/cuenta/listas" class="mt-3 inline-block underline">Ver mis listas</a>
    <div v-if="intent" class="mt-4 flex flex-wrap gap-3">
      <button data-snapshot-check type="button" :disabled="busy" class="underline" @click="check">
        Comprobar guardado
      </button>
      <button
        data-snapshot-retry
        type="button"
        :disabled="busy || (intent.action === 'create' && cart.id !== intent.cartId)"
        class="underline"
        @click="retry"
      >
        Reintentar exactamente la operación original
      </button>
    </div>
    <div v-else class="mt-4 space-y-3">
      <label class="block"
        >Nombre de la lista
        <input
          v-model="name"
          data-snapshot-name
          maxlength="80"
          :disabled="busy"
          class="mt-1 block w-full min-w-0 rounded border p-2"
      /></label>
      <div class="flex flex-wrap gap-3">
        <button
          data-snapshot-save
          type="button"
          :disabled="!canSave"
          class="rounded border px-3 py-2"
          @click="save(false)"
        >
          Guardar lista privada
        </button>
        <button
          data-snapshot-share
          type="button"
          :disabled="!canSave"
          class="rounded border px-3 py-2"
          @click="save(true)"
        >
          Guardar y crear enlace
        </button>
      </div>
      <p v-if="cart.pendingMutation || cart.blockedMutations" role="status">
        Comprueba primero la adición pendiente en el carrito.
      </p>
    </div>
    <button v-if="capability" data-snapshot-copy type="button" class="mt-3 underline" @click="copyLink">
      Copiar enlace original
    </button>
  </section>
</template>
