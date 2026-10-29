<script setup lang="ts">
import { ref } from 'vue'
const request = useRequestFetch()
type Snapshot = {
  lotId: string
  version: number
  open: boolean
  nextCursor?: string | null
  affected: Array<{ orderId: string; lineIndex: number; customerId: string | null; quantity: number }>
}
const lot = ref('')
const evidence = ref('')
const snapshot = ref<Snapshot | null>(null)
const loading = ref(false)
const error = ref('')
const receipt = ref('')
const selectedLine = ref(0)
let retry: { key: string; signature: string } | null = null
async function load() {
  const target = lot.value.trim()
  snapshot.value = null
  error.value = ''
  receipt.value = ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target)) {
    error.value = 'Introduzca un identificador de lote válido.'
    return
  }
  loading.value = true
  try {
    const data = await request<Snapshot>(`/api/admin/product-recalls/${target}`)
    if (lot.value.trim() === target) snapshot.value = { ...data, lotId: target }
  } catch {
    error.value = 'No se ha podido cargar la retirada.'
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
    const page = await request<Snapshot>(`/api/admin/product-recalls/${current.lotId}?after=${encodeURIComponent(current.nextCursor)}`)
    if (lot.value.trim() === current.lotId) {
      selectedLine.value = 0
      snapshot.value = { ...page, lotId: current.lotId }
    }
  } catch { error.value = 'No se ha podido cargar la siguiente página.' } finally { loading.value = false }
}
async function command(action: 'open' | 'communicate' | 'resolve') {
  const current = snapshot.value
  if (!current || loading.value || lot.value.trim() !== current.lotId) return
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(evidence.value)) {
    error.value = 'Indique una referencia de evidencia válida, sin datos personales.'
    return
  }
  const line = current.affected[selectedLine.value]
  if (action === 'communicate' && !line) {
    error.value = 'Seleccione una línea afectada.'
    return
  }
  const body = {
    action,
    expectedVersion: current.version,
    evidence: evidence.value,
    ...(action === 'communicate' && line ? { orderId: line.orderId, lineIndex: line.lineIndex } : {})
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
    error.value = 'No se ha podido confirmar la operación. Reintente o actualice el estado.'
  } finally {
    loading.value = false
  }
}
</script>
<template>
  <section aria-labelledby="recall-title">
    <h1 id="recall-title">Retiradas de producto</h1>
    <p>Busque un lote por su identificador. Las líneas mostradas son las asignaciones de lote registradas.</p>
    <form @submit.prevent="load">
      <label for="recall-lot">Identificador del lote</label>
      <input id="recall-lot" v-model="lot" name="lot" :disabled="loading" autocomplete="off" />
      <button type="submit" :disabled="loading">Consultar</button>
    </form>
    <p v-if="loading" role="status">Cargando…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="receipt" role="status">{{ receipt }}</p>
    <div v-if="snapshot && lot.trim() === snapshot.lotId">
      <p>Versión {{ snapshot.version }} · {{ snapshot.open ? 'Retirada abierta' : 'Sin retirada abierta' }}</p>
      <p v-if="!snapshot.affected.length">No hay líneas de lotes registradas.</p>
      <ul v-else>
        <li v-for="line in snapshot.affected" :key="`${line.orderId}:${line.lineIndex}`">
          Pedido {{ line.orderId }}, línea {{ line.lineIndex }}, cantidad {{ line.quantity }}, cliente
          {{ line.customerId ?? 'invitado' }}
        </li>
      </ul>
      <button v-if="snapshot.nextCursor" type="button" data-action="next" :disabled="loading" @click="nextPage">Siguiente página</button>
      <label for="recall-evidence">Referencia de evidencia</label>
      <input id="recall-evidence" v-model="evidence" name="evidence" :disabled="loading" autocomplete="off" />
      <button v-if="!snapshot.open" type="button" data-action="open" :disabled="loading" @click="command('open')">
        Abrir retirada
      </button>
      <template v-else>
        <label v-if="snapshot.affected.length" for="recall-line">Línea comunicada</label>
        <select v-if="snapshot.affected.length" id="recall-line" v-model.number="selectedLine" :disabled="loading">
          <option v-for="(line, index) in snapshot.affected" :key="`${line.orderId}:${line.lineIndex}`" :value="index">
            {{ line.orderId }} / {{ line.lineIndex }}
          </option>
        </select>
        <button
          type="button"
          data-action="communicate"
          :disabled="loading || !snapshot.affected.length"
          @click="command('communicate')"
        >
          Registrar comunicación
        </button>
        <button type="button" data-action="resolve" :disabled="loading" @click="command('resolve')">
          Registrar resolución
        </button>
      </template>
    </div>
  </section>
</template>
