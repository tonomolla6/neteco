<script setup lang="ts">
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { adminCapabilitiesSchema } from '~~/shared/admin-navigation'
import { parseCatalogCsvCells } from '~~/shared/catalog-tabular-core'
import {
  inventoryCountImportPreviewInputSchema,
  inventoryCountImportPreviewSchema,
  inventoryCountImportProposalInputSchema,
  inventoryCountImportApprovalInputSchema,
  inventoryCountImportSnapshotSchema,
  inventoryCountImportListSchema,
  inventoryCountImportReceiptSchema,
  inventoryCountImportCommandSchema,
  inventoryCountImportIntentHash,
  type InventoryCountImportPreview,
  type InventoryCountImportSnapshot,
  type InventoryCountImportReceipt,
  type InventoryCountImportList
} from '~~/shared/inventory-count-import'

const props = defineProps<{ scopeKey: string; enabled: boolean; pending: boolean }>()
const emit = defineEmits<{ pending: [value: boolean]; confirmed: [receipt: InventoryCountImportReceipt] }>()
const request = useRequestFetch(),
  navigation = useAdminNavigation(),
  runtime = useRuntimeConfig()
const { ready, loggedIn, user, session } = useUserSession()
const ROOT = '/api/admin/inventory/count-imports'
const caps = computed(() => {
  const parsed = adminCapabilitiesSchema.safeParse(navigation.capabilities.value)
  return parsed.success ? parsed.data : null
})
const boundary = computed(() =>
  JSON.stringify([
    props.scopeKey,
    props.enabled,
    runtime.public.serverRuntime,
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    user.value?.mfaVerified,
    session.value?.sessionId,
    session.value?.sessionVersion,
    navigation.status.value,
    caps.value
  ])
)
const revoked = ref<string | null>(null)
const authority = computed(
  () =>
    runtime.public.serverRuntime === 'cloudflare' &&
    props.enabled &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    navigation.status.value === 'ready' &&
    caps.value?.state === 'ready' &&
    caps.value.identityId === user.value.id &&
    caps.value.sessionId === session.value?.sessionId &&
    caps.value.sessionVersion === session.value?.sessionVersion &&
    caps.value.permissions.includes('inventory.read') &&
    revoked.value !== boundary.value
)
const available = computed(() => authority.value && !props.pending)
const csv = ref(''),
  reason = ref(''),
  reference = ref(''),
  approvalReason = ref(''),
  feedback = ref('')
const busy = ref(false),
  previewBusy = ref(false),
  listState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const page = ref(1),
  imports = shallowRef<InventoryCountImportList | null>(null)
const preview = shallowRef<InventoryCountImportPreview | null>(null),
  snapshot = shallowRef<InventoryCountImportSnapshot | null>(null)
const detailError = ref(false)
type ProposalBody = ReturnType<typeof inventoryCountImportProposalInputSchema.parse>
type ApprovalBody = ReturnType<typeof inventoryCountImportApprovalInputSchema.parse>
type Intent = {
  scope: string
  actor: string
  key: string
  hash: string
  sent: boolean
  rowCount: number
  changedCount: number
} & (
  | { action: 'propose'; target: null; body: ProposalBody; rows: InventoryCountImportPreview['rows'] }
  | { action: 'approve'; target: string; body: ApprovalBody; original: InventoryCountImportSnapshot }
)
const intent = shallowRef<Intent | null>(null)
type IntentDraft =
  | Omit<Extract<Intent, { action: 'propose' }>, 'key' | 'hash'>
  | Omit<Extract<Intent, { action: 'approve' }>, 'key' | 'hash'>
let alive = true,
  generation = 0,
  csvRevision = 0
const current = (scope: string, token: number) =>
  alive && available.value && scope === boundary.value && token === generation
function purge() {
  generation++
  csvRevision++
  csv.value = reason.value = reference.value = approvalReason.value = feedback.value = ''
  imports.value = null
  preview.value = null
  snapshot.value = null
  intent.value = null
  busy.value = previewBusy.value = detailError.value = false
  listState.value = 'idle'
  page.value = 1
}
function authFailure(error: unknown, scope: string) {
  const e = error as { statusCode?: number; status?: number; response?: { status?: number } }
  if (boundary.value === scope && [401, 403].includes(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)) {
    purge()
    revoked.value = scope
    return true
  }
  return false
}
async function list(requestedPage = page.value) {
  if (!available.value || busy.value || intent.value) return
  const scope = boundary.value,
    token = generation
  busy.value = true
  imports.value = null
  listState.value = 'loading'
  try {
    const data = inventoryCountImportListSchema.parse(
      await request(ROOT, { query: { page: requestedPage, perPage: 25 }, cache: 'no-store', retry: 0 })
    )
    if (!current(scope, token)) return
    if (
      data.page !== requestedPage ||
      data.perPage !== 25 ||
      new Set(data.items.map((item) => item.importId)).size !== data.items.length
    )
      throw Error('list correlation')
    imports.value = data
    page.value = requestedPage
    listState.value = 'ready'
  } catch (error) {
    if (current(scope, token) && !authFailure(error, scope)) listState.value = 'error'
  } finally {
    if (current(scope, token)) busy.value = false
  }
}
async function open(id: string) {
  if (!available.value || busy.value || intent.value) return
  const scope = boundary.value,
    token = generation
  busy.value = true
  snapshot.value = null
  detailError.value = false
  feedback.value = ''
  try {
    const data = inventoryCountImportSnapshotSchema.parse(
      await request(`${ROOT}/${id}`, { cache: 'no-store', retry: 0 })
    )
    if (!current(scope, token)) return
    if (data.importId !== id) throw Error('detail correlation')
    snapshot.value = data
    preview.value = null
  } catch (error) {
    if (current(scope, token) && !authFailure(error, scope)) detailError.value = true
  } finally {
    if (current(scope, token)) busy.value = false
  }
}
async function inspect() {
  if (!available.value || busy.value || intent.value) return
  const scope = boundary.value,
    token = generation,
    revision = csvRevision,
    text = csv.value
  preview.value = null
  feedback.value = ''
  snapshot.value = null
  try {
    inventoryCountImportPreviewInputSchema.parse({ csv: text })
    const cells = parseCatalogCsvCells(text.replace(/^\uFEFF/, ''), {
      maxRows: 101,
      maxColumns: 2,
      maxCellCharacters: 200
    })
    if (
      cells.length < 2 ||
      cells[0]?.join(',') !== 'sku,countedPhysicalQuantity' ||
      cells.some((row) => row.length !== 2)
    )
      throw Error('CSV structure')
  } catch {
    feedback.value =
      'El recuento no es válido: la primera línea debe ser sku,countedPhysicalQuantity y admite entre 1 y 100 productos.'
    return
  }
  busy.value = previewBusy.value = true
  try {
    const data = inventoryCountImportPreviewSchema.parse(
      await request(`${ROOT}/preview`, { method: 'POST', body: { csv: text }, retry: 0 })
    )
    if (!current(scope, token) || revision !== csvRevision) return
    const cells = parseCatalogCsvCells(text.replace(/^\uFEFF/, ''), {
      maxRows: 101,
      maxColumns: 2,
      maxCellCharacters: 200
    })
    if (
      data.rows.length !== cells.length - 1 ||
      data.rows.some(
        (row, index) => row.rowNumber !== index + 2 || row.sku !== cells[index + 1]?.[0]?.trim().normalize('NFC')
      )
    )
      throw Error('preview correlation')
    preview.value = data
  } catch (error) {
    if (current(scope, token) && !authFailure(error, scope))
      feedback.value = 'No hemos podido comprobar las diferencias. No se ha guardado nada; vuelve a intentarlo.'
  } finally {
    if (current(scope, token)) busy.value = previewBusy.value = false
  }
}
// Navigation exposes READ only. These per-action flags come from current D1
// authorization; the server rechecks WRITE for every command and recovery.
const canPropose = computed(
  () =>
    available.value &&
    preview.value?.canPropose === true &&
    preview.value.rows.every(
      (row) =>
        row.error === null &&
        row.variantId !== null &&
        row.expectedBalanceVersion !== null &&
        row.physicalQuantity !== null &&
        row.countedPhysicalQuantity !== null &&
        row.physicalDelta === row.countedPhysicalQuantity - row.physicalQuantity
    ) &&
    preview.value.rows.some((row) => row.physicalDelta !== 0)
)
const canApprove = computed(
  () =>
    available.value &&
    snapshot.value?.status === 'proposed' &&
    snapshot.value.version === 1 &&
    snapshot.value.capabilities.approve &&
    snapshot.value.proposedBy !== user.value?.id &&
    snapshot.value.rows.every(
      (row) =>
        !row.stale &&
        row.error === null &&
        row.currentBalanceVersion === row.expectedBalanceVersion &&
        row.currentPhysicalQuantity === row.physicalQuantity
    )
)
async function review(action: 'propose' | 'approve') {
  if (busy.value || intent.value || !available.value) return
  const scope = boundary.value,
    token = generation,
    actor = user.value!.id
  let candidate: IntentDraft
  if (action === 'propose') {
    if (!canPropose.value || !preview.value) return
    const body = inventoryCountImportProposalInputSchema.safeParse({
      csv: csv.value,
      previewHash: preview.value.previewHash,
      reason: reason.value,
      reference: reference.value
    })
    if (!body.success) {
      feedback.value = 'Escribe un nombre para el recuento y un motivo.'
      return
    }
    const rows = preview.value.rows.map((row) => ({ ...row }))
    candidate = {
      action,
      target: null,
      body: body.data,
      rows,
      scope,
      actor,
      sent: false,
      rowCount: rows.length,
      changedCount: rows.filter((row) => row.physicalDelta !== 0).length
    }
  } else {
    if (!canApprove.value || !snapshot.value) return
    const body = inventoryCountImportApprovalInputSchema.safeParse({
      expectedVersion: snapshot.value.version,
      reason: approvalReason.value
    })
    if (!body.success) {
      feedback.value = 'Escribe el motivo de la aprobación.'
      return
    }
    const original = structuredClone(snapshot.value)
    candidate = {
      action,
      target: original.importId,
      body: body.data,
      original,
      scope,
      actor,
      sent: false,
      rowCount: original.rows.length,
      changedCount: original.rows.filter((row) => row.physicalDelta !== 0).length
    }
  }
  busy.value = true
  try {
    const hash = await inventoryCountImportIntentHash(candidate.action, candidate.target, candidate.body)
    if (current(scope, token) && (candidate.action === 'propose' ? canPropose.value : canApprove.value))
      intent.value = { ...candidate, key: crypto.randomUUID(), hash }
  } catch {
    if (current(scope, token))
      feedback.value = 'No hemos podido preparar el envío. No se ha guardado nada; vuelve a intentarlo.'
  } finally {
    if (current(scope, token)) busy.value = false
  }
}
async function accept(raw: unknown, frozen: Intent, token: number) {
  const receipt = inventoryCountImportReceiptSchema.parse(raw)
  if (
    receipt.commandId !== frozen.key ||
    receipt.action !== frozen.action ||
    receipt.payloadHash !== frozen.hash ||
    receipt.expectedVersion !== (frozen.action === 'propose' ? 0 : frozen.body.expectedVersion) ||
    receipt.rowCount !== frozen.rowCount ||
    receipt.changedCount !== frozen.changedCount ||
    (frozen.action === 'approve' && receipt.importId !== frozen.target)
  )
    throw Error('receipt correlation')
  const data = inventoryCountImportSnapshotSchema.parse(
    await request(`${ROOT}/${receipt.importId}`, { cache: 'no-store', retry: 0 })
  )
  if (!current(frozen.scope, token) || intent.value !== frozen) return
  if (data.importId !== receipt.importId || data.version !== receipt.version || data.rows.length !== frozen.rowCount)
    throw Error('fresh correlation')
  const original = frozen.action === 'propose' ? frozen.rows : frozen.original.rows
  if (
    data.rows.some((row, index) => {
      const before = original[index]
      return (
        !before ||
        row.rowNumber !== before.rowNumber ||
        row.sku !== before.sku ||
        row.variantId !== before.variantId ||
        row.expectedBalanceVersion !== before.expectedBalanceVersion ||
        row.physicalQuantity !== before.physicalQuantity ||
        row.countedPhysicalQuantity !== before.countedPhysicalQuantity ||
        row.physicalDelta !== before.physicalDelta ||
        row.error !== null
      )
    })
  )
    throw Error('fresh rows correlation')
  if (frozen.action === 'propose') {
    if (
      data.status !== 'proposed' ||
      data.proposedBy !== frozen.actor ||
      data.reason !== frozen.body.reason ||
      data.reference !== frozen.body.reference
    )
      throw Error('fresh proposal')
  } else if (
    data.status !== 'approved' ||
    data.approvedBy !== frozen.actor ||
    data.proposedBy !== frozen.original.proposedBy ||
    data.rows.some(
      (row) =>
        row.currentPhysicalQuantity !== row.countedPhysicalQuantity ||
        row.currentBalanceVersion !== row.expectedBalanceVersion! + (row.physicalDelta === 0 ? 0 : 1)
    )
  )
    throw Error('fresh balances')
  snapshot.value = data
  intent.value = null
  preview.value = null
  csv.value = reason.value = reference.value = approvalReason.value = ''
  feedback.value =
    frozen.action === 'propose'
      ? 'Propuesta confirmada. El stock no ha cambiado todavía: tiene que aprobarla otra persona.'
      : 'Recuento aprobado. El stock ya refleja lo contado.'
  emit('confirmed', receipt)
}
async function send() {
  const frozen = intent.value
  if (
    !frozen ||
    !(frozen.action === 'propose' ? canPropose.value : canApprove.value) ||
    busy.value ||
    frozen.scope !== boundary.value
  )
    return
  const token = generation
  busy.value = true
  frozen.sent = true
  feedback.value = 'Enviando… El resultado es incierto hasta que lo confirmemos.'
  try {
    const response = await request(frozen.action === 'propose' ? ROOT : `${ROOT}/${frozen.target}/approve`, {
      method: 'POST',
      body: frozen.body,
      headers: { 'Idempotency-Key': frozen.key },
      retry: 0
    })
    if (current(frozen.scope, token)) await accept(response, frozen, token)
  } catch (error) {
    if (current(frozen.scope, token) && !authFailure(error, frozen.scope))
      feedback.value = 'Resultado incierto. No se repetirá automáticamente: pulsa «Comprobar si se guardó».'
  } finally {
    if (current(frozen.scope, token)) busy.value = false
  }
}
async function check() {
  const frozen = intent.value
  if (
    !frozen ||
    !(frozen.action === 'propose' ? canPropose.value : canApprove.value) ||
    busy.value ||
    frozen.scope !== boundary.value
  )
    return
  const token = generation
  busy.value = true
  try {
    const data = inventoryCountImportCommandSchema.parse(
      await request(`${ROOT}/commands/${frozen.key}`, {
        headers: { 'X-Neteco-Command-Payload-Hash': frozen.hash },
        cache: 'no-store',
        retry: 0
      })
    )
    if (!current(frozen.scope, token)) return
    if (data.outcome === 'applied') await accept(data.receipt, frozen, token)
    else feedback.value = 'Resultado incierto. Que no aparezca todavía no demuestra que no se haya guardado.'
  } catch (error) {
    if (current(frozen.scope, token) && !authFailure(error, frozen.scope))
      feedback.value = 'Resultado incierto. No hemos podido comprobarlo; vuelve a intentarlo.'
  } finally {
    if (current(frozen.scope, token)) busy.value = false
  }
}
watch(
  csv,
  () => {
    csvRevision++
    if (!intent.value) preview.value = null
  },
  { flush: 'sync' }
)
watch(
  intent,
  (value) => {
    if (alive) emit('pending', value !== null)
  },
  { flush: 'sync' }
)
watch(
  boundary,
  () => {
    purge()
    if (available.value) void list(1)
  },
  { immediate: true, flush: 'sync' }
)
watch(
  () => props.pending,
  (value) => {
    generation++
    busy.value = previewBusy.value = false
    imports.value = null
    if (!intent.value) {
      preview.value = null
      snapshot.value = null
    }
    if (!value && available.value && !intent.value) void list(1)
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  purge()
  alive = false
  generation++
})
const errors = {
  unknown_sku: 'Referencia desconocida',
  ambiguous_sku: 'Referencia repetida en el catálogo',
  duplicate_sku: 'Referencia duplicada en el fichero',
  invalid_quantity: 'Cantidad no válida',
  source_unavailable: 'No se pudo leer el stock'
}
</script>

<template>
  <section v-if="available" aria-label="Importación de recuentos CSV" class="adm-stack min-w-0">
    <UAlert v-if="feedback" role="status" color="neutral" variant="subtle" icon="i-lucide-info" :title="feedback" />

    <AdminCard v-if="intent" as="section" aria-label="Confirmar operación de recuento" title="Confirmar">
      <p>
        {{
          intent.action === 'propose'
            ? 'Vas a guardar la propuesta de recuento. El stock no cambia todavía.'
            : 'Vas a aprobar el recuento como segunda persona. El stock se ajustará a lo contado.'
        }}
        Afecta a {{ intent.changedCount }} {{ intent.changedCount === 1 ? 'producto' : 'productos' }}.
      </p>
      <p v-if="intent.sent" class="adm-help mt-2">
        No sabemos si se ha guardado: el resultado es incierto. No salgas de esta pantalla sin comprobarlo; no se
        repetirá automáticamente.
      </p>
      <template #footer>
        <template v-if="!intent.sent">
          <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy" @click="intent = null">
            Volver a revisar
          </button>
          <button
            data-count-import-confirm
            type="button"
            class="adm-btn adm-btn--primary"
            :disabled="busy"
            @click="send"
          >
            Confirmar
          </button>
        </template>
        <template v-else>
          <button
            data-count-import-check
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="busy"
            @click="check"
          >
            Comprobar si se guardó
          </button>
          <button
            data-count-import-retry
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="busy"
            @click="send"
          >
            Reintentar el mismo envío
          </button>
        </template>
      </template>
    </AdminCard>

    <AdminCard
      title="Importar un recuento"
      description="Pega lo contado en el almacén. Primero verás las diferencias; el stock solo cambia cuando otra persona aprueba el recuento."
    >
      <div class="adm-stack">
        <label class="adm-field">
          <span class="adm-label">Recuento en formato CSV</span>
          <textarea
            v-model="csv"
            data-count-import-csv
            rows="5"
            class="w-full font-mono"
            placeholder="sku,countedPhysicalQuantity&#10;REF-001,24&#10;REF-002,8"
            :disabled="busy || !!intent"
          />
          <span class="adm-help">
            Primera línea <code>sku,countedPhysicalQuantity</code> y después una línea por producto: referencia y
            unidades contadas. Entre 1 y 100 productos.
          </span>
        </label>
        <div>
          <button
            data-count-import-preview
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="busy || !!intent || !csv"
            @click="inspect"
          >
            {{ previewBusy ? 'Comprobando…' : 'Ver diferencias' }}
          </button>
        </div>
        <template v-if="preview">
          <div class="adm-table-wrap rounded-[var(--radius-surface)] border border-[var(--border)]">
            <table class="adm-table">
              <caption class="sr-only">
                Existencias en el momento de la comprobación; el stock no se ha ajustado
              </caption>
              <thead>
                <tr>
                  <th scope="col" data-numeric>Fila</th>
                  <th scope="col">Referencia</th>
                  <th scope="col" data-numeric>Stock actual</th>
                  <th scope="col" data-numeric>Contado</th>
                  <th scope="col" data-numeric>Diferencia</th>
                  <th scope="col">Resultado</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in preview.rows" :key="row.rowNumber">
                  <td data-numeric>{{ row.rowNumber }}</td>
                  <td class="break-words">{{ row.sku }}</td>
                  <td data-numeric>{{ row.physicalQuantity ?? '—' }}</td>
                  <td data-numeric>{{ row.countedPhysicalQuantity ?? 'No válido' }}</td>
                  <td data-numeric>{{ row.physicalDelta ?? '—' }}</td>
                  <td>
                    <AdminBadge :tone="row.error ? 'danger' : 'success'">
                      {{ row.error ? errors[row.error] : 'Correcta' }}
                    </AdminBadge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <UAlert
            v-if="preview.rows.some((row) => row.error)"
            role="alert"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Hay filas con errores"
            description="Corrígelas y vuelve a comprobar: no se puede guardar el recuento mientras haya errores."
          />
          <p v-else-if="preview.rows.every((row) => row.physicalDelta === 0)" class="adm-help">
            Sin diferencias: lo contado coincide con el stock, no hay nada que ajustar.
          </p>
          <p v-else-if="!preview.canPropose" class="adm-help">No tienes permiso para guardar recuentos.</p>
        </template>
        <form
          v-if="canPropose && !intent"
          data-count-import-review
          class="adm-stack border-t border-[var(--border)] pt-4"
          @submit.prevent="review('propose')"
        >
          <div class="adm-form-grid">
            <label class="adm-field">
              <span class="adm-label">Nombre del recuento</span>
              <input
                v-model="reference"
                data-count-import-reference
                maxlength="200"
                placeholder="Ej. Recuento mensual de noviembre"
                :disabled="busy"
              />
            </label>
            <label class="adm-field">
              <span class="adm-label">Motivo</span>
              <textarea v-model="reason" data-count-import-reason maxlength="500" :disabled="busy" />
            </label>
          </div>
          <div class="flex justify-end">
            <button type="submit" class="adm-btn adm-btn--primary" :disabled="busy">Guardar recuento</button>
          </div>
        </form>
      </div>
    </AdminCard>

    <UAlert
      v-if="detailError"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No hemos podido abrir ese recuento"
      description="Vuelve a intentarlo desde la lista."
    />
    <AdminCard v-if="snapshot" as="section" aria-label="Detalle del lote" :title="snapshot.reference" flush>
      <template #actions>
        <AdminBadge :tone="snapshot.status === 'approved' ? 'success' : 'warning'">
          {{ snapshot.status === 'approved' ? 'Aprobado' : 'Pendiente de aprobar' }}
        </AdminBadge>
      </template>
      <p class="break-words px-5 py-3">Motivo: {{ snapshot.reason }}</p>
      <div class="adm-table-wrap border-t border-[var(--border)]">
        <table class="adm-table">
          <thead>
            <tr>
              <th scope="col">Referencia</th>
              <th scope="col" data-numeric>Stock al contar</th>
              <th scope="col" data-numeric>Contado</th>
              <th scope="col" data-numeric>Diferencia</th>
              <th scope="col" data-numeric>Stock ahora</th>
              <th scope="col"><span class="sr-only">Avisos</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in snapshot.rows" :key="row.rowNumber">
              <td class="break-words">{{ row.sku }}</td>
              <td data-numeric>{{ row.physicalQuantity }}</td>
              <td data-numeric>{{ row.countedPhysicalQuantity }}</td>
              <td data-numeric>{{ row.physicalDelta }}</td>
              <td data-numeric>{{ row.currentPhysicalQuantity }}</td>
              <td>
                <AdminBadge v-if="row.stale" tone="warning">El stock cambió: hay que volver a contar</AdminBadge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="snapshot.status === 'proposed' && snapshot.proposedBy === user?.id" class="adm-help px-5 py-3">
        Este recuento lo guardaste tú: tiene que aprobarlo otra persona.
      </p>
      <form
        v-if="canApprove && !intent"
        data-count-import-review-approval
        class="adm-stack border-t border-[var(--border)] px-5 py-4"
        @submit.prevent="review('approve')"
      >
        <label class="adm-field">
          <span class="adm-label">Motivo de la aprobación</span>
          <textarea v-model="approvalReason" data-count-import-approval-reason maxlength="500" :disabled="busy" />
        </label>
        <div class="flex justify-end">
          <button type="submit" class="adm-btn adm-btn--primary" :disabled="busy">Aprobar recuento</button>
        </div>
      </form>
    </AdminCard>

    <AdminCard as="section" aria-label="Lotes de recuento" title="Recuentos anteriores" flush>
      <template #actions>
        <button
          type="button"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          :disabled="busy || !!intent"
          @click="list()"
        >
          <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
        </button>
      </template>
      <div v-if="listState === 'loading'" class="adm-table-skeleton" aria-busy="true" role="status">
        <span class="sr-only">Cargando recuentos…</span>
        <div v-for="row in 3" :key="row"><i /><i /><i /></div>
      </div>
      <div v-else-if="listState === 'error'" role="alert">
        <AdminEmptyState
          variant="error"
          compact
          title="No hemos podido cargar los recuentos"
          description="No significa que no haya ninguno. Vuelve a intentarlo."
        >
          <AdminButton icon="i-lucide-rotate-cw" :disabled="busy || !!intent" @click="list()">Reintentar</AdminButton>
        </AdminEmptyState>
      </div>
      <template v-if="imports">
        <AdminEmptyState
          v-if="imports.total === 0"
          compact
          icon="i-lucide-clipboard-list"
          title="Aún no hay recuentos"
          description="Cuando guardes un recuento aparecerá aquí para que otra persona lo apruebe."
        />
        <template v-else>
          <ul class="adm-list">
            <li v-for="item in imports.items" :key="item.importId" class="break-words">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">
                  {{ item.reference }}
                  <AdminBadge :tone="item.status === 'approved' ? 'success' : 'warning'">
                    {{ item.status === 'approved' ? 'Aprobado' : 'Pendiente de aprobar' }}
                  </AdminBadge>
                </p>
                <p class="adm-help">{{ adminDate(item.createdAt, true) }}</p>
              </div>
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :data-count-import-open="item.importId"
                :disabled="busy || !!intent"
                @click="open(item.importId)"
              >
                Abrir
              </button>
            </li>
          </ul>
          <nav aria-label="Páginas de lotes" class="adm-pagination">
            <p>{{ imports.total }} {{ imports.total === 1 ? 'recuento' : 'recuentos' }}</p>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="busy || !!intent || page <= 1"
                @click="list(page - 1)"
              >
                Anterior
              </button>
              <span class="tabular-nums">Página {{ page }}</span>
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="busy || !!intent || page * imports.perPage >= imports.total"
                @click="list(page + 1)"
              >
                Siguiente
              </button>
            </div>
          </nav>
        </template>
      </template>
    </AdminCard>
  </section>
  <AdminCard v-else>
    <AdminEmptyState
      compact
      icon="i-lucide-clock"
      title="Los recuentos no están disponibles ahora"
      description="Termina primero el cambio que tienes a medias en otra pestaña, o comprueba que tu sesión tiene permiso de inventario."
    />
  </AdminCard>
</template>
