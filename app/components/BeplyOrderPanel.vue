<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { z } from 'zod'
import BeplyOrderStatus from './BeplyOrderStatus.vue'
import { beplyOrderViewSchema, type BeplyOrderView } from '~~/shared/beply-orders'
import { fiscalUuid } from '~~/shared/fiscal-issuance'

const props = defineProps<{
  orderId: string
  audience: 'customer' | 'admin'
  scopeKey: string
  enabled: boolean
  pending?: boolean
}>()
const request = useRequestFetch()
const snapshot = shallowRef<BeplyOrderView | null>(null)
const loading = ref(false)
const failed = ref(false)
const retrying = ref(false)
const retryFailed = ref(false)
const reason = ref('')
const retryIntent = shallowRef<{ commandId: string; expectedVersion: number; reason: string } | null>(null)
const retryResponse = z.object({ version: z.number().int().positive() }).strict()
let generation = 0
let controller: AbortController | null = null
function purge() {
  generation++
  controller?.abort()
  controller = null
  snapshot.value = null
  loading.value = failed.value = retrying.value = retryFailed.value = false
  reason.value = ''
  retryIntent.value = null
}
function authorized() {
  return (
    props.enabled &&
    !props.pending &&
    !!props.scopeKey &&
    fiscalUuid.safeParse(props.orderId).success &&
    ['customer', 'admin'].includes(props.audience)
  )
}
async function load() {
  if (!authorized()) return
  const epoch = generation,
    orderId = props.orderId,
    audience = props.audience
  const ownController = new AbortController()
  controller = ownController
  loading.value = true
  failed.value = false
  try {
    const endpoint: string = `/api/${audience === 'admin' ? 'admin/' : ''}orders/${orderId}/beply`
    const raw: unknown = await request(endpoint, {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      signal: ownController.signal
    })
    if (epoch !== generation) return
    const checked = beplyOrderViewSchema.safeParse(raw)
    if (!checked.success || checked.data.orderId !== orderId || checked.data.audience !== audience)
      throw new Error('beply_order_unconfirmed')
    snapshot.value = checked.data
  } catch {
    if (epoch === generation) {
      snapshot.value = null
      failed.value = true
    }
  } finally {
    if (epoch === generation) {
      loading.value = false
      controller = null
    }
  }
}
async function retry() {
  if (
    !authorized() ||
    props.audience !== 'admin' ||
    snapshot.value?.status !== 'manual_review' ||
    retrying.value ||
    loading.value
  )
    return
  const normalized = reason.value.trim()
  if (!retryIntent.value && (normalized.length < 10 || normalized.length > 500)) {
    retryFailed.value = true
    return
  }
  const intent = retryIntent.value ?? {
    commandId: crypto.randomUUID(),
    expectedVersion: snapshot.value.version,
    reason: normalized
  }
  retryIntent.value = intent
  const epoch = generation,
    orderId = props.orderId,
    ownController = new AbortController()
  controller = ownController
  retrying.value = true
  retryFailed.value = false
  try {
    const endpoint: string = `/api/admin/orders/${orderId}/beply/retry`
    const raw: unknown = await request(endpoint, {
      method: 'POST',
      retry: 0,
      cache: 'no-store',
      body: intent,
      signal: ownController.signal
    })
    if (epoch !== generation) return
    const receipt = retryResponse.parse(raw)
    if (receipt.version !== intent.expectedVersion + 1) throw new Error('retry_unconfirmed')
    retryIntent.value = null
    reason.value = ''
    await load()
  } catch {
    // Preserve the exact intent after a lost response. Repeating it asks D1 for
    // its idempotent receipt and cannot silently start a different command.
    if (epoch === generation) retryFailed.value = true
  } finally {
    if (epoch === generation) {
      retrying.value = false
      if (controller === ownController) controller = null
    }
  }
}
watch(
  () => [props.orderId, props.audience, props.scopeKey, props.enabled, props.pending],
  async () => {
    purge()
    const epoch = generation
    await nextTick()
    if (epoch === generation) await load()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(purge)
</script>

<template>
  <div v-if="enabled" class="space-y-3">
    <BeplyOrderStatus :view="snapshot" :pending="loading || pending" :failed="failed" />
    <form
      v-if="audience === 'admin' && snapshot?.status === 'manual_review' && !loading && !pending"
      data-beply-retry-form
      class="space-y-3 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] p-5"
      @submit.prevent="retry"
    >
      <p role="status">La sincronización necesita revisión.</p>
      <p v-if="snapshot.lastErrorCode === 'credentials'">Revisa las credenciales de Beply antes de reintentar.</p>
      <label class="block">
        <span>Motivo del reintento</span>
        <textarea
          v-model="reason"
          data-beply-retry-reason
          required
          minlength="10"
          maxlength="500"
          :disabled="retrying || !!retryIntent"
          class="mt-1 block w-full rounded-lg border border-[var(--border-strong)] p-2"
        />
      </label>
      <p v-if="retryFailed" role="alert">
        No se ha podido confirmar el reintento. Comprueba el motivo y vuelve a intentarlo.
      </p>
      <button type="submit" :disabled="retrying" class="rounded-lg border border-[var(--border-strong)] px-4 py-2">
        {{ retrying ? 'Comprobando…' : retryIntent ? 'Volver a comprobar' : 'Reintentar sincronización' }}
      </button>
    </form>
  </div>
</template>
