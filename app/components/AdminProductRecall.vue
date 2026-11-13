<script setup lang="ts">
import { computed, ref } from 'vue'
const request = useRequestFetch()
type Snapshot = {
  lotId: string
  version: number
  open: boolean
  nextCursor?: string | null
  affected: Array<{
    orderId: string
    lineIndex: number
    customerId: string | null
    quantity: number
    confirmedQuantity: number
    untrackedQuantity: number
    traceabilityConflict: number
  }>
}
const lot = ref('')
const evidence = ref('')
const targetLotId = ref('')
const traceQuantity = ref<number | null>(null)
const snapshot = ref<Snapshot | null>(null)
const loading = ref(false)
const error = ref('')
const receipt = ref('')
const selectedLine = ref(0)
const LOAD_ERROR = 'No se ha podido cargar la retirada. Comprueba el identificador y vuelve a intentarlo.'
/** La consulta solo se muestra mientras el identificador escrito sigue siendo el consultado. */
const shown = computed(() => (snapshot.value && lot.value.trim() === snapshot.value.lotId ? snapshot.value : null))
function shortId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) ? `#${value.slice(0, 8).toUpperCase()}` : value
}
let retry: { key: string; signature: string } | null = null
async function load() {
  const target = lot.value.trim()
  snapshot.value = null
  error.value = ''
  receipt.value = ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target)) {
    error.value = 'Ese identificador de lote no es válido. Cópialo completo, con sus guiones.'
    return
  }
  loading.value = true
  try {
    const data = await request<Snapshot>(`/api/admin/product-recalls/${target}`)
    if (lot.value.trim() === target) snapshot.value = { ...data, lotId: target }
  } catch {
    error.value = LOAD_ERROR
  } finally {
    loading.value = false
  }
}
async function nextPage() {
  const current = snapshot.value
  if (!current?.nextCursor || loading.value || lot.value.trim() !== current.lotId) return
  loading.value = true
  error.value = ''
  try {
    const page = await request<Snapshot>(
      `/api/admin/product-recalls/${current.lotId}?after=${encodeURIComponent(current.nextCursor)}`
    )
    if (lot.value.trim() === current.lotId) {
      selectedLine.value = 0
      snapshot.value = { ...page, lotId: current.lotId }
    }
  } catch {
    error.value = 'No se ha podido cargar la siguiente página. Vuelve a intentarlo.'
  } finally {
    loading.value = false
  }
}
async function command(action: 'open' | 'communicate' | 'trace' | 'resolve') {
  const current = snapshot.value
  if (!current || loading.value || lot.value.trim() !== current.lotId) return
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(evidence.value)) {
    error.value = 'Escribe la referencia del justificante: de 8 a 100 letras, números o guiones, sin datos personales.'
    return
  }
  const line = current.affected[selectedLine.value]
  if ((action === 'communicate' || action === 'trace') && !line) {
    error.value = 'Elige un pedido afectado en la tabla.'
    return
  }
  if (
    action === 'trace' &&
    (!line ||
      !line.untrackedQuantity ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetLotId.value.trim()) ||
      !Number.isInteger(traceQuantity.value) ||
      !traceQuantity.value ||
      traceQuantity.value < 1 ||
      traceQuantity.value > line.untrackedQuantity)
  ) {
    error.value = 'Indica el lote comprobado y un número de unidades que no supere las que están sin lote verificado.'
    return
  }
  const body = {
    action,
    expectedVersion: current.version,
    evidence: evidence.value,
    ...((action === 'communicate' || action === 'trace') && line
      ? { orderId: line.orderId, lineIndex: line.lineIndex }
      : {}),
    ...(action === 'trace' ? { targetLotId: targetLotId.value.trim(), quantity: traceQuantity.value } : {})
  }
  const signature = JSON.stringify([current.lotId, body])
  if (retry?.signature !== signature) retry = { key: crypto.randomUUID(), signature }
  loading.value = true
  error.value = ''
  receipt.value = ''
  try {
    await request(`/api/admin/product-recalls/${current.lotId}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': retry.key },
      body
    })
    retry = null
    const updated = await request<Snapshot>(`/api/admin/product-recalls/${current.lotId}`)
    if (lot.value.trim() === current.lotId) {
      snapshot.value = { ...updated, lotId: current.lotId }
      receipt.value = 'Operación registrada.'
    }
  } catch {
    error.value = 'No se ha podido confirmar la operación. Vuelve a intentarlo o consulta el lote de nuevo.'
  } finally {
    loading.value = false
  }
}
</script>
<template>
  <section aria-labelledby="recall-title" class="adm-stack">
    <h2 id="recall-title" class="sr-only">Retirada de un lote</h2>
    <UAlert
      v-if="error"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="error"
      :actions="
        error === LOAD_ERROR
          ? [{ label: 'Reintentar', color: 'neutral', variant: 'outline', onClick: () => void load() }]
          : undefined
      "
    />
    <UAlert
      v-if="receipt"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="receipt"
    />

    <div class="adm-card adm-tablecard">
      <div class="adm-tablecard__bar">
        <form class="adm-toolbar" role="search" @submit.prevent="load">
          <label for="recall-lot" class="sr-only">Identificador del lote</label>
          <div class="adm-toolbar__search">
            <UIcon name="i-lucide-search" class="size-4" />
            <input
              id="recall-lot"
              v-model="lot"
              name="lot"
              data-slot="adm-search"
              placeholder="Identificador del lote"
              :disabled="loading"
              autocomplete="off"
            />
          </div>
          <button type="submit" class="adm-btn adm-btn--secondary" :disabled="loading">Consultar</button>
          <p v-if="loading" role="status" class="adm-help">Cargando…</p>
          <div v-if="shown" class="adm-toolbar__end">
            <AdminBadge :tone="shown.open ? 'danger' : 'neutral'">
              {{ shown.open ? 'Retirada abierta' : 'Sin retirada abierta' }}
            </AdminBadge>
          </div>
        </form>
      </div>

      <AdminEmptyState
        v-if="!shown"
        icon="i-lucide-triangle-alert"
        title="Consulta un lote para empezar"
        description="Pega el identificador del lote afectado para ver a qué pedidos se envió, avisar a los clientes y dejar constancia de la retirada."
      />
      <AdminEmptyState
        v-else-if="!shown.affected.length"
        icon="i-lucide-package-check"
        title="No hay líneas de lotes registradas"
        description="Este lote no consta como enviado en ningún pedido."
      />
      <template v-else>
        <div class="adm-table-wrap">
          <table class="adm-table">
            <caption class="sr-only">
              Pedidos que recibieron este lote
            </caption>
            <thead>
              <tr>
                <th v-if="shown.open" scope="col" style="width: 2.5rem"><span class="sr-only">Elegir</span></th>
                <th scope="col">Pedido</th>
                <th scope="col">Cliente</th>
                <th scope="col" data-numeric>Unidades confirmadas</th>
                <th scope="col" data-numeric>Unidades sin lote verificado</th>
                <th scope="col"><span class="sr-only">Avisos</span></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(line, index) in shown.affected"
                :key="`${line.orderId}:${line.lineIndex}`"
                :data-selected="(shown.open && selectedLine === index) || undefined"
              >
                <td v-if="shown.open">
                  <input
                    v-model.number="selectedLine"
                    type="radio"
                    name="recall-line"
                    :value="index"
                    :disabled="loading"
                    :aria-label="`Elegir el pedido ${shortId(line.orderId)}, línea ${line.lineIndex + 1}`"
                  />
                </td>
                <td :title="line.orderId">
                  <span class="font-semibold text-[var(--text-strong)]">{{ shortId(line.orderId) }}</span>
                  <span class="adm-help"> · línea {{ line.lineIndex + 1 }}</span>
                </td>
                <td :title="line.customerId ?? undefined">
                  {{ line.customerId ? shortId(line.customerId) : 'Invitado' }}
                </td>
                <td data-numeric>{{ line.confirmedQuantity }}</td>
                <td data-numeric>{{ line.untrackedQuantity }}</td>
                <td>
                  <AdminBadge v-if="line.traceabilityConflict" tone="danger">
                    Datos de lote incoherentes: no se puede cerrar la retirada
                  </AdminBadge>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="shown.nextCursor" class="adm-pagination">
          <p>Hay más pedidos afectados.</p>
          <button
            type="button"
            data-action="next"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="loading"
            @click="nextPage"
          >
            Siguiente página
          </button>
        </div>
      </template>
    </div>

    <AdminCard
      v-if="shown"
      :title="shown.open ? 'Gestionar la retirada' : 'Abrir una retirada'"
      :description="
        shown.open
          ? 'Cada paso queda registrado con el justificante que indiques.'
          : 'Al abrirla podrás registrar los avisos a los clientes y el cierre.'
      "
    >
      <div class="adm-stack">
        <div class="adm-field max-w-md">
          <label for="recall-evidence" class="adm-label">Referencia del justificante</label>
          <input id="recall-evidence" v-model="evidence" name="evidence" :disabled="loading" autocomplete="off" />
          <p class="adm-help">
            Código del documento que respalda la acción: de 8 a 100 letras, números o guiones, sin datos personales.
          </p>
        </div>

        <template v-if="shown.open">
          <div class="border-t border-[var(--border)] pt-4">
            <h3>Asignar el lote real a un pedido</h3>
            <p class="adm-help mt-1">
              Solo si puedes demostrar qué lote recibió el pedido elegido en la tabla. Las unidades se descontarán de
              ese lote.
            </p>
            <div class="adm-form-grid mt-3">
              <div class="adm-field">
                <label for="recall-target-lot" class="adm-label">Lote comprobado</label>
                <input
                  id="recall-target-lot"
                  v-model="targetLotId"
                  name="targetLotId"
                  placeholder="Identificador del lote"
                  :disabled="loading"
                  autocomplete="off"
                />
              </div>
              <div class="adm-field">
                <label for="recall-trace-quantity" class="adm-label">Unidades comprobadas</label>
                <input
                  id="recall-trace-quantity"
                  v-model.number="traceQuantity"
                  name="quantity"
                  type="number"
                  min="1"
                  max="999"
                  :disabled="loading"
                />
              </div>
            </div>
          </div>
        </template>
      </div>
      <template #footer>
        <button
          v-if="!shown.open"
          type="button"
          data-action="open"
          class="adm-btn adm-btn--primary"
          :disabled="loading"
          @click="command('open')"
        >
          Abrir retirada
        </button>
        <template v-else>
          <button
            type="button"
            data-action="trace"
            class="adm-btn adm-btn--secondary"
            :disabled="loading || !shown.affected.length"
            @click="command('trace')"
          >
            Asignar lote al pedido
          </button>
          <button
            type="button"
            data-action="communicate"
            class="adm-btn adm-btn--secondary"
            :disabled="loading || !shown.affected.length"
            @click="command('communicate')"
          >
            Registrar aviso al cliente
          </button>
          <button
            type="button"
            data-action="resolve"
            class="adm-btn adm-btn--primary"
            :disabled="loading"
            @click="command('resolve')"
          >
            Cerrar la retirada
          </button>
        </template>
      </template>
    </AdminCard>
  </section>
</template>
