<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { PackingConfigView, PackingSuggestionView } from '../../shared/packing-optimizer-api'
import { newCommandId } from '../composables/useDeliveryDriverApp'
import { opsErrorMessage } from '../utils/shipping-ops-errors'

const requestFetch = useRequestFetch()
const BASE = '/api/admin/packing-optimizer'

const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)
const config = ref<PackingConfigView | null>(null)
const suggestion = ref<PackingSuggestionView | null>(null)
const linesText = ref('')
const linesError = ref<string | null>(null)
const rejectNote = ref('')
const rejectError = ref<string | null>(null)
const actual = ref<number[]>([])

const statusLabel = { suggested: 'Pendiente de validar', validated: 'Validada', rejected: 'Rechazada' } as const

async function loadConfig() {
  try {
    config.value = (await requestFetch<PackingConfigView>(BASE)) as PackingConfigView
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  } finally {
    loading.value = false
  }
}

function parseLines(): Array<{ sku: string; quantity: number }> | null {
  const lines: Array<{ sku: string; quantity: number }> = []
  for (const raw of linesText.value.split('\n')) {
    const text = raw.trim()
    if (!text) continue
    const match = /^(\S.*?)\s*[x×]\s*(\d+)$/i.exec(text)
    const quantity = match ? Number(match[2]) : 0
    if (!match || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 500) return null
    lines.push({ sku: match[1]!.trim(), quantity })
  }
  return lines.length ? lines : null
}

async function suggest() {
  linesError.value = null
  error.value = null
  const lines = parseLines()
  if (!lines) {
    linesError.value = 'Escribe una línea por producto con el formato "SKU x cantidad" (cantidad entera entre 1 y 500).'
    return
  }
  busy.value = true
  try {
    const res = (await requestFetch<{ suggestion: PackingSuggestionView }>(`${BASE}/suggestions`, {
      method: 'POST',
      body: { commandId: newCommandId(), lines }
    })) as { suggestion: PackingSuggestionView }
    suggestion.value = res.suggestion
    actual.value = res.suggestion.plan.parcels.map((p) => p.grossWeightGrams)
    await loadConfig()
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function decide(decision: 'accept' | 'reject') {
  if (!suggestion.value) return
  rejectError.value = null
  error.value = null
  if (decision === 'reject' && rejectNote.value.trim().length < 10) {
    rejectError.value = 'Explica el motivo del rechazo (mínimo 10 caracteres).'
    return
  }
  busy.value = true
  try {
    const body =
      decision === 'accept'
        ? {
            commandId: newCommandId(),
            expectedVersion: suggestion.value.version,
            decision,
            actualParcels: actual.value.map((weightGrams, parcelIndex) => ({
              parcelIndex,
              weightGrams: Number(weightGrams)
            }))
          }
        : {
            commandId: newCommandId(),
            expectedVersion: suggestion.value.version,
            decision,
            note: rejectNote.value.trim()
          }
    const res = (await requestFetch<{ suggestion: PackingSuggestionView }>(
      `${BASE}/suggestions/${suggestion.value.id}/decision`,
      {
        method: 'POST',
        body
      }
    )) as { suggestion: PackingSuggestionView }
    suggestion.value = res.suggestion
    await loadConfig()
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  } finally {
    busy.value = false
  }
}

onMounted(() => void loadConfig())
</script>

<template>
  <div class="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 class="text-lg font-semibold text-slate-900">Optimización de embalaje</h2>
    <p class="text-sm text-slate-600">
      Heurística determinista (respeta incompatibilidades, peso y dimensiones). Toda propuesta debe validarse en almacén
      con el peso real.
    </p>

    <div v-if="loading" role="status" aria-live="polite" class="text-sm text-slate-500">
      Cargando configuración de embalaje...
    </div>
    <p v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      {{ error }}
    </p>

    <template v-if="config">
      <div class="grid gap-4 md:grid-cols-3">
        <section aria-labelledby="boxes-title">
          <h3 id="boxes-title" class="font-medium">Cajas</h3>
          <ul class="text-sm">
            <li v-for="b in config.boxes" :key="b.code">
              {{ b.code }} · {{ b.name }} · {{ b.widthMm }}×{{ b.heightMm }}×{{ b.depthMm }} mm · máx.
              {{ b.maxWeightGrams }} g{{ b.active ? '' : ' · inactiva'
              }}{{ b.hazmatAllowed ? '' : ' · sin mercancía peligrosa' }}
            </li>
          </ul>
        </section>
        <section aria-labelledby="profiles-title">
          <h3 id="profiles-title" class="font-medium">Perfiles de producto</h3>
          <ul class="text-sm">
            <li v-for="p in config.profiles" :key="p.sku">{{ p.sku }} · {{ p.weightGrams }} g · {{ p.hazardClass }}</li>
          </ul>
          <p v-if="!config.profiles.length" class="text-sm text-slate-500">
            Sin perfiles: añade peso y dimensiones por SKU.
          </p>
        </section>
        <section aria-labelledby="rules-title">
          <h3 id="rules-title" class="font-medium">Incompatibilidades</h3>
          <ul class="text-sm">
            <li v-for="r in config.incompatibilities" :key="`${r.classA}-${r.classB}`">
              {{ r.classA }} + {{ r.classB }}: {{ r.reason }}
            </li>
          </ul>
        </section>
      </div>

      <form class="space-y-2" @submit.prevent="suggest">
        <label class="block text-sm font-medium text-slate-700">
          Productos del pedido (uno por línea: SKU x cantidad)
          <textarea
            v-model="linesText"
            data-test="lines"
            rows="4"
            class="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm"
          />
        </label>
        <p v-if="linesError" data-test="lines-error" role="alert" class="text-sm text-red-700">{{ linesError }}</p>
        <button
          type="button"
          data-test="suggest"
          :disabled="busy"
          class="rounded-lg bg-neteco-600 px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50"
          @click="suggest"
        >
          Calcular embalaje
        </button>
      </form>

      <section v-if="suggestion" data-test="plan" class="space-y-3 border-t pt-4" aria-label="Propuesta de embalaje">
        <h3 class="font-semibold">
          {{ suggestion.plan.totals.parcelCount }} {{ suggestion.plan.totals.parcelCount === 1 ? 'bulto' : 'bultos' }} ·
          {{ suggestion.plan.totals.grossWeightGrams }} g brutos · {{ statusLabel[suggestion.status] }}
        </h3>
        <ol class="space-y-2 text-sm">
          <li
            v-for="(parcel, index) in suggestion.plan.parcels"
            :key="index"
            class="rounded-lg border border-slate-200 p-3"
          >
            <p class="font-medium">
              Bulto {{ index + 1 }} · Caja {{ parcel.boxCode }} · {{ parcel.grossWeightGrams }} g previstos · relleno
              {{ Math.round(parcel.fillRatioBp / 100) }} %
            </p>
            <p>{{ parcel.contents.map((c) => `${c.quantity} × ${c.sku}`).join(', ') }}</p>
            <p v-if="parcel.hazardClasses.some((h) => h !== 'none')" class="text-xs text-amber-800">
              Clases de peligro: {{ parcel.hazardClasses.filter((h) => h !== 'none').join(', ') }}
            </p>
            <label v-if="suggestion.status === 'suggested'" class="mt-1 block text-xs font-medium text-slate-700">
              Peso real en almacén (g)
              <input
                v-model.number="actual[index]"
                :data-test="`actual-${index}`"
                type="number"
                min="1"
                class="ml-2 w-28 rounded-md border border-slate-300 px-2 py-1"
              />
            </label>
          </li>
        </ol>
        <div v-if="suggestion.status === 'suggested'" class="space-y-2">
          <button
            type="button"
            data-test="accept"
            :disabled="busy"
            class="rounded-lg bg-emerald-700 px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50"
            @click="decide('accept')"
          >
            Validar en almacén
          </button>
          <label class="block text-sm font-medium text-slate-700">
            Motivo si se rechaza
            <input
              v-model="rejectNote"
              data-test="reject-note"
              maxlength="500"
              class="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5"
            />
          </label>
          <p v-if="rejectError" data-test="reject-error" role="alert" class="text-sm text-red-700">{{ rejectError }}</p>
          <button
            type="button"
            data-test="reject"
            :disabled="busy"
            class="rounded-lg border border-red-300 px-3.5 py-2 text-sm font-medium text-red-800 disabled:opacity-50"
            @click="decide('reject')"
          >
            Rechazar propuesta
          </button>
        </div>
      </section>
    </template>
  </div>
</template>
