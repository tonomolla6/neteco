<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface BacklogItem {
  term: string
  searches: number
  zeroResults: number
  zeroRate: number
  existingAction: 'synonym' | 'redirect' | 'none'
}

interface SearchGapCase {
  id: string
  termNormalized: string
  termDisplay: string
  status: 'open' | 'actioned' | 'dismissed'
  actionType: 'synonym' | 'content' | 'assortment' | 'redirect' | null
  baselineZeroRate: number
  outcomeZeroRate: number | null
  verdict: string | null
  version: number
  createdAt: string
  updatedAt: string
}

interface Measurement {
  before: { searches: number; zeroResults: number; zeroRate: number }
  after: { searches: number; zeroResults: number; zeroRate: number }
  deltaPercent: number
  verdict: string
}

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

const backlog = ref<BacklogItem[]>([])
const cases = ref<SearchGapCase[]>([])
const statusFilter = ref<'open' | 'actioned' | 'dismissed'>('open')

// Action dialog / inline form
const activeCase = ref<SearchGapCase | null>(null)
const actionType = ref<'synonym' | 'content' | 'assortment' | 'redirect'>('synonym')
const targetReference = ref('')
const actionNote = ref('')
const actioning = ref(false)

// Measurement modal
const measuredCaseId = ref<string | null>(null)
const measurement = ref<Measurement | null>(null)

function errorMessage(caught: unknown): string {
  const code = (caught as { data?: { error?: { code?: string } } })?.data?.error?.code
  if (code) return code
  return caught instanceof Error ? caught.message : 'error_servidor'
}

function randomUuid(): string {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `gap-${Date.now()}`
}

async function loadData() {
  loading.value = true
  error.value = null
  try {
    const [backlogRes, casesRes] = await Promise.all([
      requestFetch<{ items: BacklogItem[] }>('/api/admin/search-gaps/backlog'),
      requestFetch<{ items: SearchGapCase[] }>(`/api/admin/search-gaps?status=${statusFilter.value}`)
    ])
    backlog.value = backlogRes.items ?? []
    cases.value = casesRes.items ?? []
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    loading.value = false
  }
}

async function openCase(term: string) {
  notice.value = null
  error.value = null
  try {
    const key = randomUuid()
    await requestFetch('/api/admin/search-gaps', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': key
      },
      body: {
        action: 'open_case',
        term
      }
    })
    notice.value = `Caso abierto para el término "${term}".`
    await loadData()
  } catch (caught) {
    error.value = errorMessage(caught)
  }
}

async function recordAction() {
  if (!activeCase.value || !targetReference.value.trim()) return
  actioning.value = true
  error.value = null
  try {
    const key = randomUuid()
    await requestFetch('/api/admin/search-gaps', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': key
      },
      body: {
        action: 'record_action',
        id: activeCase.value.id,
        expectedVersion: activeCase.value.version,
        actionType: actionType.value,
        targetReference: targetReference.value.trim(),
        note: actionNote.value.trim() || undefined
      }
    })
    notice.value = `Acción registrada para "${activeCase.value.termDisplay}".`
    activeCase.value = null
    targetReference.value = ''
    actionNote.value = ''
    await loadData()
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    actioning.value = false
  }
}

async function measure(caseItem: SearchGapCase) {
  measuredCaseId.value = caseItem.id
  measurement.value = null
  try {
    const res = await requestFetch<Measurement>(`/api/admin/search-gaps/${caseItem.id}/measurement`)
    measurement.value = res
  } catch (caught) {
    error.value = errorMessage(caught)
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-bold text-slate-900">Programa de búsquedas sin resultado (SEO-025)</h1>
      <p class="text-sm text-slate-600">
        Bucle cerrado para términos con alta tasa de cero resultados: apertura de caso, acción (sinónimo, contenido,
        surtido, redirect) y medición de impacto.
      </p>
    </header>

    <div
      v-if="notice"
      data-test="notice"
      role="status"
      aria-live="polite"
      class="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
    >
      {{ notice }}
    </div>

    <div v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      Error: {{ error }}
    </div>

    <!-- Backlog Section -->
    <section
      aria-labelledby="backlog-heading"
      class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs space-y-4"
    >
      <div class="flex items-center justify-between">
        <h2 id="backlog-heading" class="text-base font-semibold text-slate-900">
          Backlog de términos sin resultados ({{ backlog.length }})
        </h2>
        <button
          type="button"
          class="rounded bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
          @click="loadData"
        >
          Actualizar
        </button>
      </div>

      <div v-if="backlog.length === 0 && !loading" class="text-xs text-slate-500 py-4 text-center">
        No hay términos con alta tasa de cero resultados en los últimos días.
      </div>

      <div v-else class="overflow-x-auto rounded-lg border border-slate-100">
        <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
          <thead class="bg-slate-50 font-medium text-slate-600">
            <tr>
              <th scope="col" class="px-3 py-2">Término</th>
              <th scope="col" class="px-3 py-2">Búsquedas</th>
              <th scope="col" class="px-3 py-2">Sin resultado</th>
              <th scope="col" class="px-3 py-2">Tasa</th>
              <th scope="col" class="px-3 py-2 text-right">Acción</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="item in backlog" :key="item.term" class="hover:bg-slate-50">
              <td class="px-3 py-2 font-medium text-slate-900">{{ item.term }}</td>
              <td class="px-3 py-2 text-slate-600">{{ item.searches }}</td>
              <td class="px-3 py-2 text-slate-600">{{ item.zeroResults }}</td>
              <td class="px-3 py-2 font-semibold text-amber-700">{{ (item.zeroRate * 100).toFixed(1) }}%</td>
              <td class="px-3 py-2 text-right">
                <button
                  type="button"
                  data-test="open-case-btn"
                  class="rounded bg-indigo-600 px-2.5 py-1 text-white hover:bg-indigo-500"
                  @click="openCase(item.term)"
                >
                  Abrir caso
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Cases Management -->
    <section
      aria-labelledby="cases-heading"
      class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs space-y-4"
    >
      <div class="flex items-center justify-between">
        <h2 id="cases-heading" class="text-base font-semibold text-slate-900">Casos del programa</h2>
        <div class="flex gap-2 text-xs">
          <select v-model="statusFilter" class="rounded border p-1" @change="loadData">
            <option value="open">Abiertos</option>
            <option value="actioned">Accionados</option>
            <option value="dismissed">Descartados</option>
          </select>
        </div>
      </div>

      <div v-if="cases.length === 0 && !loading" class="text-xs text-slate-500 py-4 text-center">
        No hay casos con estado "{{ statusFilter }}".
      </div>

      <div v-else class="overflow-x-auto rounded-lg border border-slate-100">
        <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
          <thead class="bg-slate-50 font-medium text-slate-600">
            <tr>
              <th scope="col" class="px-3 py-2">Término</th>
              <th scope="col" class="px-3 py-2">Estado</th>
              <th scope="col" class="px-3 py-2">Tasa basal</th>
              <th scope="col" class="px-3 py-2">Acción aplicada</th>
              <th scope="col" class="px-3 py-2 text-right">Operaciones</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="c in cases" :key="c.id" class="hover:bg-slate-50">
              <td class="px-3 py-2 font-medium text-slate-900">{{ c.termDisplay }}</td>
              <td class="px-3 py-2">
                <span
                  class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  :class="{
                    'bg-amber-50 text-amber-700': c.status === 'open',
                    'bg-emerald-50 text-emerald-700': c.status === 'actioned',
                    'bg-slate-100 text-slate-600': c.status === 'dismissed'
                  }"
                >
                  {{ c.status }}
                </span>
              </td>
              <td class="px-3 py-2 text-slate-600">{{ (c.baselineZeroRate * 100).toFixed(1) }}%</td>
              <td class="px-3 py-2 text-slate-600">{{ c.actionType ?? 'Pendiente' }}</td>
              <td class="px-3 py-2 text-right space-x-2">
                <button
                  v-if="c.status === 'open'"
                  type="button"
                  class="rounded bg-slate-800 px-2 py-1 text-white hover:bg-slate-700"
                  @click="activeCase = c"
                >
                  Registrar acción
                </button>
                <button
                  v-if="c.status === 'actioned'"
                  type="button"
                  class="rounded bg-indigo-50 px-2 py-1 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
                  @click="measure(c)"
                >
                  Medir impacto
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Action Modal / Section -->
    <div v-if="activeCase" class="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 text-xs space-y-3">
      <h3 class="font-bold text-slate-900">Registrar acción para "{{ activeCase.termDisplay }}"</h3>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label class="block text-slate-700 font-medium">Tipo de acción</label>
          <select v-model="actionType" class="mt-1 w-full rounded border p-1 bg-white">
            <option value="synonym">Sinónimo gobernado</option>
            <option value="redirect">Redirección merchandising</option>
            <option value="content">Publicación de contenido</option>
            <option value="assortment">Alta de surtido</option>
          </select>
        </div>
        <div>
          <label class="block text-slate-700 font-medium">Referencia de destino (URL o ID)</label>
          <input
            v-model="targetReference"
            placeholder="/catalogo/..."
            class="mt-1 w-full rounded border p-1 bg-white"
          />
        </div>
        <div>
          <label class="block text-slate-700 font-medium">Nota técnica</label>
          <input
            v-model="actionNote"
            placeholder="Añadido sinónimo en catálogo..."
            class="mt-1 w-full rounded border p-1 bg-white"
          />
        </div>
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          :disabled="actioning || !targetReference"
          class="rounded bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          @click="recordAction"
        >
          {{ actioning ? 'Guardando...' : 'Confirmar acción' }}
        </button>
        <button
          type="button"
          class="rounded border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700"
          @click="activeCase = null"
        >
          Cancelar
        </button>
      </div>
    </div>

    <!-- Measurement Result -->
    <div v-if="measurement" class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs space-y-2">
      <h3 class="font-bold text-emerald-900">Medición de impacto de la acción</h3>
      <p>
        <span class="font-medium">Veredicto:</span> {{ measurement.verdict }} (<span
          :class="measurement.deltaPercent < 0 ? 'text-emerald-700 font-bold' : 'text-slate-700'"
        >
          {{ measurement.deltaPercent.toFixed(1) }}% de cambio en cero resultados </span
        >)
      </p>
      <div class="grid grid-cols-2 gap-4 text-slate-700">
        <div>
          <p class="font-medium">Antes de la acción:</p>
          <p>
            {{ measurement.before.searches }} búsquedas, {{ measurement.before.zeroResults }} sin resultado ({{
              (measurement.before.zeroRate * 100).toFixed(1)
            }}%)
          </p>
        </div>
        <div>
          <p class="font-medium">Después de la acción:</p>
          <p>
            {{ measurement.after.searches }} búsquedas, {{ measurement.after.zeroResults }} sin resultado ({{
              (measurement.after.zeroRate * 100).toFixed(1)
            }}%)
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
