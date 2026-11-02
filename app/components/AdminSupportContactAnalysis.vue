<script setup lang="ts">
import { randomId } from '../utils/uuid'
import { ROOT_CAUSE_LABELS, formatInstant, formatRate } from '../utils/support-insights-labels'

/** SUP-014: contact rate by order, product and carrier, with root cause and a backlog fed by evidence. */
interface Group {
  key: string
  contacts: number
  touches?: number
  orders?: number
  ratePer100Orders?: number | null
  estimatedCostCents?: number
}
interface Suggestion {
  dimension: string
  dimensionKey: string
  rootCause: string
  contacts: number
  sharePct: number
  ratePer100Orders: number | null
  priority: 'low' | 'normal' | 'high'
  title: string
}
interface Analysis {
  window: { from: string; to: string }
  totals: {
    orders: number
    contacts: number
    ratePer100Orders: number | null
    touches: number
    estimatedCostCents: number | null
  }
  byCategory: Group[]
  byRootCause: Group[]
  byCarrier: Group[]
  byProduct: Group[]
  byOrder: Group[]
  suggestions: Suggestion[]
}
interface BacklogItem {
  id: string
  dimension: string
  dimensionKey: string
  title: string
  priority: string
  status: string
  version: number
  createdAt: string
}
const request = useRequestFetch()
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const from = ref(day(-30)),
  to = ref(day(1)),
  touchCost = ref('')
const state = ref<'loading' | 'ready' | 'error'>('loading'),
  errorText = ref(''),
  notice = ref(''),
  busy = ref(false)
const analysis = ref<Analysis | null>(null),
  backlog = ref<BacklogItem[]>([])
const dimensionLabels: Record<string, string> = {
  carrier: 'transportista',
  product: 'producto',
  category: 'categoría',
  root_cause: 'causa raíz',
  order: 'pedido'
}

async function load() {
  state.value = 'loading'
  errorText.value = ''
  try {
    const params = new URLSearchParams({ from: from.value, to: to.value })
    if (touchCost.value.trim() !== '') params.set('touchCostCents', String(Math.round(Number(touchCost.value) * 100)))
    const [a, b] = await Promise.all([
      request(`/api/admin/support/contact-analysis?${params}`) as Promise<Analysis>,
      request('/api/admin/support/contact-analysis/backlog') as Promise<{ items: BacklogItem[] }>
    ])
    analysis.value = a
    backlog.value = b.items
    state.value = 'ready'
  } catch {
    errorText.value = 'No hemos podido cargar el análisis de contactos.'
    state.value = 'error'
  }
}
async function reloadBacklog() {
  backlog.value = ((await request('/api/admin/support/contact-analysis/backlog')) as { items: BacklogItem[] }).items
}
async function addToBacklog(s: Suggestion) {
  busy.value = true
  notice.value = ''
  try {
    await request<unknown, string>('/api/admin/support/contact-analysis/backlog', {
      method: 'POST',
      headers: { 'idempotency-key': randomId() },
      body: {
        dimension: s.dimension,
        dimensionKey: s.dimensionKey,
        rootCause: s.rootCause,
        title: s.title,
        priority: s.priority,
        from: analysis.value!.window.from,
        to: analysis.value!.window.to,
        evidence: { contacts: s.contacts, sharePct: s.sharePct, ratePer100Orders: s.ratePer100Orders }
      }
    })
    notice.value = 'Añadido al backlog.'
    await reloadBacklog()
  } catch (error) {
    const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
    notice.value =
      code === 'duplicate_backlog'
        ? 'Ese hallazgo ya está en el backlog para esta ventana.'
        : 'No se pudo añadir al backlog.'
  } finally {
    busy.value = false
  }
}
async function move(item: BacklogItem, action: 'plan' | 'complete' | 'dismiss') {
  busy.value = true
  notice.value = ''
  try {
    await request<unknown, string>(`/api/admin/support/contact-analysis/backlog/${item.id}/commands`, {
      method: 'POST',
      headers: { 'idempotency-key': randomId() },
      body: { action, expectedVersion: item.version }
    })
    await reloadBacklog()
  } catch {
    notice.value = 'El elemento ha cambiado o la acción no es válida. Recarga la lista.'
  } finally {
    busy.value = false
  }
}
const label = (key: string) => ROOT_CAUSE_LABELS[key] ?? key
onMounted(load)
</script>

<template>
  <section class="space-y-6">
    <div>
      <h2 class="text-xl font-bold text-slate-900">Análisis de contactos</h2>
      <p class="text-sm text-slate-500">
        SUP-014: tasa de contacto por pedido, producto y transportista, causa raíz y backlog.
      </p>
    </div>
    <form class="flex flex-wrap items-end gap-3" @submit.prevent="load">
      <label class="text-xs font-semibold uppercase text-slate-500"
        >Desde<input
          v-model="from"
          type="date"
          required
          class="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm normal-case"
      /></label>
      <label class="text-xs font-semibold uppercase text-slate-500"
        >Hasta (excl.)<input
          v-model="to"
          type="date"
          required
          class="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm normal-case"
      /></label>
      <label class="text-xs font-semibold uppercase text-slate-500"
        >Coste por gestión (€)<input
          v-model="touchCost"
          type="number"
          min="0"
          step="0.01"
          class="mt-1 block w-28 rounded border border-slate-300 px-2 py-1 text-sm"
      /></label>
      <button type="submit" class="rounded-lg bg-neteco-600 px-4 py-2 text-sm font-semibold text-white">
        Actualizar
      </button>
    </form>

    <p v-if="state === 'error'" role="alert" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">{{ errorText }}</p>
    <p v-else-if="notice" role="status" class="rounded-lg bg-slate-50 p-3 text-sm">{{ notice }}</p>
    <p v-if="state === 'loading'" class="text-sm text-slate-500">Calculando…</p>

    <template v-if="state === 'ready' && analysis">
      <p
        v-if="analysis.totals.orders === 0 && analysis.totals.contacts === 0"
        class="rounded-xl border border-dashed p-6 text-center text-sm text-slate-600"
      >
        Sin pedidos ni contactos en esta ventana.
      </p>
      <dl class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="rounded-xl border bg-white p-4">
          <dt class="text-xs uppercase text-slate-500">Pedidos</dt>
          <dd class="text-2xl font-bold">{{ analysis.totals.orders }}</dd>
        </div>
        <div class="rounded-xl border bg-white p-4">
          <dt class="text-xs uppercase text-slate-500">Contactos</dt>
          <dd class="text-2xl font-bold">{{ analysis.totals.contacts }}</dd>
        </div>
        <div class="rounded-xl border bg-white p-4">
          <dt class="text-xs uppercase text-slate-500">Contactos por 100 pedidos</dt>
          <dd class="text-2xl font-bold">{{ formatRate(analysis.totals.ratePer100Orders) }}</dd>
        </div>
        <div class="rounded-xl border bg-white p-4">
          <dt class="text-xs uppercase text-slate-500">Coste estimado</dt>
          <dd class="text-2xl font-bold">
            {{
              analysis.totals.estimatedCostCents === null
                ? 'Sin coste definido'
                : formatRate(analysis.totals.estimatedCostCents / 100) + ' €'
            }}
          </dd>
        </div>
      </dl>

      <div class="grid gap-4 lg:grid-cols-2">
        <div
          v-for="[title, rows] in [
            ['Por transportista', analysis.byCarrier],
            ['Por producto', analysis.byProduct]
          ] as const"
          :key="title"
          class="rounded-xl border bg-white p-4"
        >
          <h3 class="font-semibold">{{ title }}</h3>
          <p v-if="rows.length === 0" class="mt-2 text-sm text-slate-500">Sin contactos asociados.</p>
          <table v-else class="mt-2 w-full text-sm">
            <thead>
              <tr class="text-left text-xs uppercase text-slate-500">
                <th scope="col">Clave</th>
                <th scope="col">Pedidos</th>
                <th scope="col">Contactos</th>
                <th scope="col">Por 100</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.key">
                <td>{{ row.key }}</td>
                <td>{{ row.orders }}</td>
                <td>{{ row.contacts }}</td>
                <td>{{ formatRate(row.ratePer100Orders) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="rounded-xl border bg-white p-4">
          <h3 class="font-semibold">Causa raíz</h3>
          <ul class="mt-2 text-sm">
            <li v-for="row in analysis.byRootCause" :key="row.key">
              {{ label(row.key) }}: {{ row.contacts }} contactos, {{ row.touches }} gestiones
            </li>
          </ul>
        </div>
        <div class="rounded-xl border bg-white p-4">
          <h3 class="font-semibold">Categoría y pedidos con contactos repetidos</h3>
          <ul class="mt-2 text-sm">
            <li v-for="row in analysis.byCategory" :key="row.key">{{ row.key }}: {{ row.contacts }} contactos</li>
            <li v-for="row in analysis.byOrder" :key="row.key" class="font-mono text-xs">
              {{ row.key }}: {{ row.contacts }} contactos
            </li>
          </ul>
        </div>
      </div>

      <div class="rounded-xl border bg-white p-4">
        <h3 class="font-semibold">Hallazgos para el backlog</h3>
        <p v-if="analysis.suggestions.length === 0" class="mt-2 text-sm text-slate-500">
          Ningún grupo concentra suficientes contactos.
        </p>
        <ul class="mt-2 space-y-2">
          <li
            v-for="s in analysis.suggestions"
            :key="s.dimension + s.dimensionKey"
            class="flex flex-wrap items-center justify-between gap-2 text-sm"
          >
            <span
              >{{ s.title }} · {{ s.contacts }} contactos ({{ s.sharePct }} %) ·
              {{ dimensionLabels[s.dimension] }}</span
            >
            <button
              type="button"
              data-test="suggestion-add"
              :disabled="busy"
              class="rounded border border-neteco-600 px-3 py-1 text-xs font-semibold text-neteco-700 disabled:opacity-50"
              @click="addToBacklog(s)"
            >
              Añadir al backlog
            </button>
          </li>
        </ul>
      </div>

      <div class="rounded-xl border bg-white p-4">
        <h3 class="font-semibold">Backlog de causas raíz</h3>
        <p v-if="backlog.length === 0" class="mt-2 text-sm text-slate-500">El backlog está vacío.</p>
        <ul class="mt-2 space-y-2">
          <li v-for="item in backlog" :key="item.id" class="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span
              >{{ item.title }} · {{ item.priority }} · {{ item.status }} · {{ formatInstant(item.createdAt) }}</span
            >
            <span class="flex gap-2">
              <button
                v-if="item.status === 'open'"
                type="button"
                data-test="backlog-plan"
                class="rounded border px-2 py-1 text-xs"
                @click="move(item, 'plan')"
              >
                Planificar
              </button>
              <button
                v-if="item.status === 'planned'"
                type="button"
                data-test="backlog-complete"
                class="rounded border px-2 py-1 text-xs"
                @click="move(item, 'complete')"
              >
                Completar
              </button>
              <button
                v-if="item.status === 'open' || item.status === 'planned'"
                type="button"
                data-test="backlog-dismiss"
                class="rounded border px-2 py-1 text-xs"
                @click="move(item, 'dismiss')"
              >
                Descartar
              </button>
            </span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
