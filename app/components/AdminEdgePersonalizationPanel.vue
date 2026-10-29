<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Rule {
  id: string
  slot: string
  segment: 'b2c_new' | 'b2c_returning' | 'b2b'
  variantKey: string
  status: 'draft' | 'enabled' | 'disabled'
  version: number
}

const requestFetch = useRequestFetch()
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')
const rules = ref<Rule[]>([])
const form = ref({ slot: '', segment: 'b2b', variantKey: '' })
const evidence = ref<Record<string, Record<string, number>>>({})
const segmentLabel: Record<string, string> = { b2c_new: 'B2C nuevo', b2c_returning: 'B2C recurrente', b2b: 'B2B' }

function errorText(error: unknown, fallback: string): string {
  const data = (error as { data?: { error?: { code?: string; message?: string } } })?.data?.error
  return data?.code
    ? `${fallback} (${data.code}${data.message && data.message !== data.code ? `: ${data.message}` : ''})`
    : fallback
}

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    rules.value =
      ((await requestFetch('/api/admin/performance/edge-personalization/rules')) as { rules: Rule[] })?.rules ?? []
  } catch (error) {
    errorMessage.value = errorText(error, 'No se pudieron cargar las reglas')
  } finally {
    loading.value = false
  }
}

async function post(path: string, body: Record<string, unknown>, success: string) {
  busy.value = true
  errorMessage.value = ''
  notice.value = ''
  try {
    await requestFetch(`/api/admin/performance/edge-personalization/${path}`, {
      method: 'POST',
      body: { commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), ...body }
    })
    notice.value = success
    await load()
  } catch (error) {
    errorMessage.value = errorText(error, 'La operación no se pudo completar')
  } finally {
    busy.value = false
  }
}

const createRule = () =>
  post(
    'rules',
    { slot: form.value.slot.trim(), segment: form.value.segment, variantKey: form.value.variantKey.trim() },
    'Regla creada en borrador.'
  )
const enable = (r: Rule) => post('rules/enable', { ruleId: r.id, expectedVersion: r.version }, 'Regla activada.')
const disable = (r: Rule) =>
  post('rules/disable', { ruleId: r.id, expectedVersion: r.version }, 'Regla desactivada: vuelve al valor por defecto.')
function saveEvidence(r: Rule) {
  const e = evidence.value[r.id] ?? {}
  return post(
    'rules/evidence',
    {
      ruleId: r.id,
      controlVisitors: Number(e.controlVisitors ?? 0),
      controlConversions: Number(e.controlConversions ?? 0),
      treatmentVisitors: Number(e.treatmentVisitors ?? 0),
      treatmentConversions: Number(e.treatmentConversions ?? 0),
      lcpDeltaMs: Number(e.lcpDeltaMs ?? 0),
      cacheHitRateBps: Number(e.cacheHitRateBps ?? 0),
      baselineCacheHitRateBps: Number(e.baselineCacheHitRateBps ?? 0)
    },
    'Evidencia registrada.'
  )
}
const fields: Array<[string, string]> = [
  ['controlVisitors', 'Visitantes control'],
  ['controlConversions', 'Conversiones control'],
  ['treatmentVisitors', 'Visitantes variante'],
  ['treatmentConversions', 'Conversiones variante'],
  ['lcpDeltaMs', 'Delta LCP (ms)'],
  ['cacheHitRateBps', 'Hit rate caché con regla (bps)'],
  ['baselineCacheHitRateBps', 'Hit rate caché base (bps)']
]

onMounted(load)
</script>

<template>
  <section class="space-y-4" aria-labelledby="edge-title" data-edge-panel>
    <div>
      <h2 id="edge-title" class="text-lg font-semibold text-neutral-900">Personalización en el borde (limitada)</h2>
      <p class="text-xs text-neutral-600">
        Solo tres segmentos gruesos, con consentimiento y sin datos personales. Una regla solo se activa con evidencia
        suficiente, sin degradar LCP ni caché; si falla, se sirve el valor por defecto.
      </p>
    </div>
    <div v-if="errorMessage" role="alert" class="rounded bg-red-100 p-3 text-sm text-red-700" data-error>
      {{ errorMessage }} <button type="button" class="ml-2 underline" data-retry @click="load">Reintentar</button>
    </div>
    <div v-if="notice" role="status" class="rounded bg-emerald-100 p-3 text-sm text-emerald-700">{{ notice }}</div>

    <form class="grid gap-3 rounded border border-neutral-200 bg-white p-4 sm:grid-cols-4" @submit.prevent="createRule">
      <label class="text-xs font-medium">
        Hueco (slot)
        <input
          v-model="form.slot"
          required
          pattern="[a-z][a-z0-9_]{1,39}"
          placeholder="home_hero"
          class="mt-1 w-full rounded border px-2 py-1 text-sm"
        />
      </label>
      <label class="text-xs font-medium">
        Segmento
        <select v-model="form.segment" class="mt-1 w-full rounded border px-2 py-1 text-sm">
          <option v-for="(label, key) in segmentLabel" :key="key" :value="key">{{ label }}</option>
        </select>
      </label>
      <label class="text-xs font-medium">
        Variante
        <input
          v-model="form.variantKey"
          required
          pattern="[a-z][a-z0-9_]{1,39}"
          placeholder="bulk_offer"
          class="mt-1 w-full rounded border px-2 py-1 text-sm"
        />
      </label>
      <div class="flex items-end">
        <button
          type="submit"
          class="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          :disabled="busy"
        >
          Crear borrador
        </button>
      </div>
    </form>

    <p v-if="loading" class="py-4 text-center text-sm text-neutral-500" data-loading>Cargando reglas...</p>
    <p v-else-if="!rules.length && !errorMessage" class="py-4 text-center text-sm text-neutral-500" data-empty>
      No hay reglas de personalización.
    </p>
    <ul v-else class="space-y-3">
      <li v-for="r in rules" :key="r.id" class="rounded border border-neutral-200 bg-white p-3 text-sm" data-rule>
        <div class="flex flex-wrap items-center gap-2">
          <strong>{{ r.slot }}</strong>
          <span class="text-xs text-neutral-600">{{ segmentLabel[r.segment] }} → {{ r.variantKey }}</span>
          <span class="rounded bg-neutral-100 px-2 text-xs" data-status>{{ r.status }}</span>
          <button
            v-if="r.status === 'enabled'"
            type="button"
            class="rounded border px-2 py-1 text-xs disabled:opacity-50"
            :disabled="busy"
            data-disable
            @click="disable(r)"
          >
            Desactivar
          </button>
          <button
            v-else
            type="button"
            class="rounded bg-emerald-600 px-2 py-1 text-xs text-white disabled:opacity-50"
            :disabled="busy"
            data-enable
            @click="enable(r)"
          >
            Activar (exige evidencia)
          </button>
        </div>
        <details v-if="r.status !== 'enabled'" class="mt-2">
          <summary class="cursor-pointer text-xs text-indigo-700">Registrar evidencia del experimento</summary>
          <div class="mt-2 grid gap-2 sm:grid-cols-4">
            <label v-for="[key, label] in fields" :key="key" class="text-xs">
              {{ label }}
              <input
                v-model.number="(evidence[r.id] ??= {})[key]"
                type="number"
                class="mt-1 w-full rounded border px-2 py-1 text-sm"
              />
            </label>
          </div>
          <button
            type="button"
            class="mt-2 rounded border px-2 py-1 text-xs disabled:opacity-50"
            :disabled="busy"
            data-save-evidence
            @click="saveEvidence(r)"
          >
            Guardar evidencia
          </button>
        </details>
      </li>
    </ul>
  </section>
</template>
