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
    feedback.value = 'CSV no válido: cabecera sku,countedPhysicalQuantity, 1–100 filas y máximo 64 KiB.'
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
      feedback.value = 'No se pudo confirmar la previsualización. No se ha presentado ningún lote.'
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
      feedback.value = 'Indique un motivo y una referencia válidos.'
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
      feedback.value = 'La aprobación independiente necesita un motivo válido.'
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
    if (current(scope, token)) feedback.value = 'No se pudo preparar el intento. No se ha enviado ninguna operación.'
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
      ? 'Propuesta confirmada. No se ha modificado el stock; debe aprobarla otro operador.'
      : 'Recuento aprobado y balances actuales confirmados. No autoriza efectos económicos.'
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
  feedback.value = 'Resultado incierto hasta comprobar el recibo y la lectura actual.'
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
      feedback.value = 'Resultado incierto. No se repetirá automáticamente; compruebe la operación original.'
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
    else feedback.value = 'Resultado incierto. Un recibo desconocido no demuestra ausencia de cambios.'
  } catch (error) {
    if (current(frozen.scope, token) && !authFailure(error, frozen.scope))
      feedback.value = 'Resultado incierto. No se pudo confirmar el recibo y el balance.'
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
  unknown_sku: 'SKU desconocido',
  ambiguous_sku: 'SKU ambiguo',
  duplicate_sku: 'SKU duplicado',
  invalid_quantity: 'Cantidad no válida',
  source_unavailable: 'Existencias no confirmadas'
}
</script>

<template>
  <section
    v-if="available"
    aria-label="Importación de recuentos CSV"
    class="min-w-0 space-y-4 rounded-2xl border border-slate-200 bg-white p-5"
  >
    <h2 class="text-xl font-semibold">Importación de recuentos CSV</h2>
    <p>
      Un único almacén. La previsualización y la propuesta no modifican stock. Otro operador debe aprobar todas las
      diferencias sobre las versiones confirmadas; nunca se sobrescriben balances cambiados.
    </p>
    <section aria-label="Lotes de recuento">
      <h3 class="font-semibold">Lotes registrados</h3>
      <p v-if="listState === 'loading'" role="status">Consultando lotes…</p>
      <p v-else-if="listState === 'error'" role="alert">
        No se pudieron confirmar los lotes. No se interpreta como una lista vacía.
      </p>
      <template v-if="imports">
        <p v-if="imports.total === 0">No hay lotes registrados.</p>
        <ul>
          <li v-for="item in imports.items" :key="item.importId" class="break-words">
            <button
              type="button"
              :data-count-import-open="item.importId"
              :disabled="busy || !!intent"
              @click="open(item.importId)"
            >
              {{ item.reference }} · {{ item.status === 'approved' ? 'Aprobado' : 'Propuesto' }} · {{ item.createdAt }}
            </button>
          </li>
        </ul>
        <nav aria-label="Páginas de lotes" class="flex flex-wrap gap-3">
          <button type="button" :disabled="busy || !!intent || page <= 1" @click="list(page - 1)">Anterior</button
          ><span>Página {{ page }}</span
          ><button
            type="button"
            :disabled="busy || !!intent || page * imports.perPage >= imports.total"
            @click="list(page + 1)"
          >
            Siguiente
          </button>
        </nav>
      </template>
      <button type="button" :disabled="busy || !!intent" @click="list()">Actualizar lotes</button>
    </section>
    <label class="block"
      >CSV UTF-8 · cabecera <code>sku,countedPhysicalQuantity</code> · 1–100 filas, máximo 64 KiB<textarea
        v-model="csv"
        data-count-import-csv
        rows="5"
        class="mt-2 block w-full rounded border p-2"
        :disabled="busy || !!intent"
      />
    </label>
    <button data-count-import-preview type="button" :disabled="busy || !!intent || !csv" @click="inspect">
      {{ previewBusy ? 'Comprobando…' : 'Previsualizar diferencias' }}
    </button>
    <div v-if="preview" class="max-w-full overflow-x-auto">
      <table class="w-full text-left text-sm">
        <caption>
          Existencias observadas al previsualizar; no se ha ajustado el stock
        </caption>
        <thead>
          <tr>
            <th>Fila</th>
            <th>SKU</th>
            <th>Físico actual</th>
            <th>Recuento</th>
            <th>Diferencia</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in preview.rows" :key="row.rowNumber">
            <td>{{ row.rowNumber }}</td>
            <td class="break-words">{{ row.sku }}</td>
            <td>{{ row.physicalQuantity ?? 'No confirmado' }}</td>
            <td>{{ row.countedPhysicalQuantity ?? 'No válido' }}</td>
            <td>{{ row.physicalDelta ?? 'No confirmada' }}</td>
            <td>{{ row.error ? errors[row.error] : 'Fila válida' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="preview.rows.some((row) => row.error)" role="alert">
        Hay errores por fila: el lote completo queda bloqueado.
      </p>
      <p v-else-if="preview.rows.every((row) => row.physicalDelta === 0)">
        Sin diferencias. No se generará un movimiento cero.
      </p>
      <p v-else-if="!preview.canPropose">
        Esta lectura no autoriza presentar el lote. Se necesita permiso de escritura vigente.
      </p>
    </div>
    <form v-if="canPropose && !intent" data-count-import-review class="space-y-3" @submit.prevent="review('propose')">
      <label class="block"
        >Motivo<textarea
          v-model="reason"
          data-count-import-reason
          maxlength="500"
          :disabled="busy"
          class="block w-full rounded border p-2"
        />
      </label>
      <label class="block"
        >Referencia del recuento<input
          v-model="reference"
          data-count-import-reference
          maxlength="200"
          :disabled="busy"
          class="block w-full rounded border p-2"
      /></label>
      <button type="submit" :disabled="busy">Revisar propuesta</button>
    </form>
    <p v-if="detailError" role="alert">No se pudo confirmar el lote seleccionado.</p>
    <section v-if="snapshot" aria-label="Detalle del lote" class="min-w-0 space-y-3">
      <h3 class="font-semibold">
        {{ snapshot.reference }} · {{ snapshot.status === 'approved' ? 'Aprobado' : 'Propuesto' }}
      </h3>
      <p class="break-words">Motivo: {{ snapshot.reason }} · Propuesto por {{ snapshot.proposedBy }}</p>
      <ul>
        <li v-for="row in snapshot.rows" :key="row.rowNumber" class="break-words">
          {{ row.sku }} · observado {{ row.physicalQuantity }} · contado {{ row.countedPhysicalQuantity }} · diferencia
          {{ row.physicalDelta }} · físico confirmado ahora {{ row.currentPhysicalQuantity }} · versión
          {{ row.currentBalanceVersion }}<span v-if="row.stale"> · El balance cambió; no puede sobrescribirse.</span>
        </li>
      </ul>
      <p v-if="snapshot.status === 'proposed' && snapshot.proposedBy === user?.id">
        La aprobación requiere otro operador.
      </p>
      <form v-if="canApprove && !intent" data-count-import-review-approval @submit.prevent="review('approve')">
        <label class="block"
          >Motivo de aprobación independiente<textarea
            v-model="approvalReason"
            data-count-import-approval-reason
            maxlength="500"
            :disabled="busy"
            class="block w-full rounded border p-2"
          /></label
        ><button type="submit" :disabled="busy">Revisar aprobación</button>
      </form>
    </section>
    <section v-if="intent" aria-label="Confirmar operación de recuento" class="rounded border border-amber-300 p-3">
      <p>
        {{
          intent.action === 'propose'
            ? 'Presentar propuesta sin modificar stock'
            : 'Aprobar diferencias de stock como segundo operador'
        }}
        · {{ intent.changedCount }} diferencias.
      </p>
      <template v-if="!intent.sent"
        ><button data-count-import-confirm type="button" :disabled="busy" @click="send">Confirmar operación</button
        ><button type="button" :disabled="busy" @click="intent = null">Volver a revisar</button></template
      >
      <template v-else
        ><button data-count-import-check type="button" :disabled="busy" @click="check">
          Comprobar operación original</button
        ><button data-count-import-retry type="button" :disabled="busy" @click="send">
          Reintentar exactamente el mismo intento
        </button></template
      >
      <p v-if="intent.sent">
        No abandone este contexto sin revisar el resultado incierto. No se ha supuesto ausencia ni se repetirá
        automáticamente.
      </p>
    </section>
    <p v-if="feedback" role="status">{{ feedback }}</p>
  </section>
</template>
