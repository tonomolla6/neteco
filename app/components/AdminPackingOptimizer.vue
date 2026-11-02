<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { PackingConfigView, PackingSuggestionView } from '~~/shared/packing-optimizer-api'
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

const newBox = ref({
  code: '',
  name: '',
  widthMm: 200,
  heightMm: 150,
  depthMm: 150,
  tareGrams: 150,
  maxWeightGrams: 5000,
  hazmatAllowed: true,
  active: true
})

const newProfile = ref({
  sku: '',
  weightGrams: 1000,
  widthMm: 100,
  heightMm: 100,
  depthMm: 100,
  hazardClass: 'none'
})

const newIncomp = ref({
  classA: '',
  classB: '',
  reason: ''
})

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

async function saveBox() {
  if (!newBox.value.code || !newBox.value.name) return
  busy.value = true
  error.value = null
  try {
    await requestFetch(`${BASE}/boxes/${encodeURIComponent(newBox.value.code)}`, {
      method: 'PUT',
      body: {
        name: newBox.value.name,
        widthMm: Number(newBox.value.widthMm),
        heightMm: Number(newBox.value.heightMm),
        depthMm: Number(newBox.value.depthMm),
        tareGrams: Number(newBox.value.tareGrams),
        maxWeightGrams: Number(newBox.value.maxWeightGrams),
        hazmatAllowed: Boolean(newBox.value.hazmatAllowed),
        active: Boolean(newBox.value.active)
      }
    })
    await loadConfig()
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function saveProfile() {
  if (!newProfile.value.sku) return
  busy.value = true
  error.value = null
  try {
    await requestFetch(`${BASE}/profiles/${encodeURIComponent(newProfile.value.sku)}`, {
      method: 'PUT',
      body: {
        weightGrams: Number(newProfile.value.weightGrams),
        widthMm: Number(newProfile.value.widthMm),
        heightMm: Number(newProfile.value.heightMm),
        depthMm: Number(newProfile.value.depthMm),
        hazardClass: newProfile.value.hazardClass
      }
    })
    await loadConfig()
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function saveIncompatibility() {
  if (!newIncomp.value.classA || !newIncomp.value.classB || !newIncomp.value.reason) return
  busy.value = true
  error.value = null
  try {
    await requestFetch(`${BASE}/incompatibilities`, {
      method: 'PUT',
      body: {
        classA: newIncomp.value.classA,
        classB: newIncomp.value.classB,
        reason: newIncomp.value.reason
      }
    })
    await loadConfig()
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function deleteIncomp(classA: string, classB: string) {
  busy.value = true
  error.value = null
  try {
    await requestFetch(`${BASE}/incompatibilities/${encodeURIComponent(classA)}/${encodeURIComponent(classB)}`, {
      method: 'DELETE'
    })
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
        <section aria-labelledby="boxes-title" class="space-y-3">
          <h3 id="boxes-title" class="font-medium">Cajas</h3>
          <ul class="text-sm">
            <li v-for="b in config.boxes" :key="b.code">
              {{ b.code }} · {{ b.name }} · {{ b.widthMm }}×{{ b.heightMm }}×{{ b.depthMm }} mm · máx.
              {{ b.maxWeightGrams }} g{{ b.active ? '' : ' · inactiva'
              }}{{ b.hazmatAllowed ? '' : ' · sin mercancía peligrosa' }}
            </li>
          </ul>

          <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-2">
            <h4 class="font-medium text-slate-800">Añadir / editar caja</h4>
            <div class="grid grid-cols-2 gap-2">
              <input
                v-model="newBox.code"
                data-test="new-box-code"
                placeholder="Código (ej. S)"
                class="rounded border p-1"
              />
              <input v-model="newBox.name" data-test="new-box-name" placeholder="Nombre" class="rounded border p-1" />
              <input
                v-model.number="newBox.widthMm"
                data-test="new-box-width"
                type="number"
                placeholder="Ancho mm"
                class="rounded border p-1"
              />
              <input
                v-model.number="newBox.heightMm"
                data-test="new-box-height"
                type="number"
                placeholder="Alto mm"
                class="rounded border p-1"
              />
              <input
                v-model.number="newBox.depthMm"
                data-test="new-box-depth"
                type="number"
                placeholder="Fondo mm"
                class="rounded border p-1"
              />
              <input
                v-model.number="newBox.tareGrams"
                data-test="new-box-tare"
                type="number"
                placeholder="Tara g"
                class="rounded border p-1"
              />
              <input
                v-model.number="newBox.maxWeightGrams"
                data-test="new-box-max-weight"
                type="number"
                placeholder="Máx g"
                class="rounded border p-1"
              />
              <label class="flex items-center gap-1">
                <input v-model="newBox.hazmatAllowed" type="checkbox" /> ADR
              </label>
            </div>
            <button
              type="button"
              data-test="save-box-btn"
              :disabled="busy || !newBox.code || !newBox.name"
              class="w-full rounded bg-slate-800 py-1 text-white hover:bg-slate-700 disabled:opacity-50"
              @click="saveBox"
            >
              Guardar caja
            </button>
          </div>
        </section>

        <section aria-labelledby="profiles-title" class="space-y-3">
          <h3 id="profiles-title" class="font-medium">Perfiles de producto</h3>
          <ul class="text-sm">
            <li v-for="p in config.profiles" :key="p.sku">{{ p.sku }} · {{ p.weightGrams }} g · {{ p.hazardClass }}</li>
          </ul>
          <p v-if="!config.profiles.length" class="text-sm text-slate-500">
            Sin perfiles: añade peso y dimensiones por SKU.
          </p>

          <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-2">
            <h4 class="font-medium text-slate-800">Añadir / editar perfil</h4>
            <div class="grid grid-cols-2 gap-2">
              <input
                v-model="newProfile.sku"
                data-test="new-profile-sku"
                placeholder="SKU"
                class="rounded border p-1"
              />
              <input
                v-model.number="newProfile.weightGrams"
                data-test="new-profile-weight"
                type="number"
                placeholder="Peso g"
                class="rounded border p-1"
              />
              <input
                v-model.number="newProfile.widthMm"
                data-test="new-profile-width"
                type="number"
                placeholder="Ancho mm"
                class="rounded border p-1"
              />
              <input
                v-model.number="newProfile.heightMm"
                data-test="new-profile-height"
                type="number"
                placeholder="Alto mm"
                class="rounded border p-1"
              />
              <input
                v-model.number="newProfile.depthMm"
                data-test="new-profile-depth"
                type="number"
                placeholder="Fondo mm"
                class="rounded border p-1"
              />
              <select v-model="newProfile.hazardClass" data-test="new-profile-hazard" class="rounded border p-1">
                <option value="none">Sin peligro</option>
                <option value="corrosive">Corrosivo</option>
                <option value="flammable">Inflamable</option>
                <option value="toxic">Tóxico</option>
                <option value="oxidizer">Comburente</option>
              </select>
            </div>
            <button
              type="button"
              data-test="save-profile-btn"
              :disabled="busy || !newProfile.sku"
              class="w-full rounded bg-slate-800 py-1 text-white hover:bg-slate-700 disabled:opacity-50"
              @click="saveProfile"
            >
              Guardar perfil
            </button>
          </div>
        </section>

        <section aria-labelledby="rules-title" class="space-y-3">
          <h3 id="rules-title" class="font-medium">Incompatibilidades</h3>
          <ul class="text-sm">
            <li
              v-for="r in config.incompatibilities"
              :key="`${r.classA}-${r.classB}`"
              class="flex justify-between items-center py-0.5"
            >
              <span>{{ r.classA }} + {{ r.classB }}: {{ r.reason }}</span>
              <button
                type="button"
                class="text-red-600 hover:text-red-800 ml-2"
                @click="deleteIncomp(r.classA, r.classB)"
              >
                ✕
              </button>
            </li>
          </ul>

          <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-2">
            <h4 class="font-medium text-slate-800">Añadir incompatibilidad</h4>
            <div class="space-y-2">
              <div class="grid grid-cols-2 gap-2">
                <input
                  v-model="newIncomp.classA"
                  data-test="new-incomp-a"
                  placeholder="Clase A"
                  class="rounded border p-1"
                />
                <input
                  v-model="newIncomp.classB"
                  data-test="new-incomp-b"
                  placeholder="Clase B"
                  class="rounded border p-1"
                />
              </div>
              <input
                v-model="newIncomp.reason"
                data-test="new-incomp-reason"
                placeholder="Motivo técnico"
                class="w-full rounded border p-1"
              />
            </div>
            <button
              type="button"
              data-test="save-incomp-btn"
              :disabled="busy || !newIncomp.classA || !newIncomp.classB || !newIncomp.reason"
              class="w-full rounded bg-slate-800 py-1 text-white hover:bg-slate-700 disabled:opacity-50"
              @click="saveIncompatibility"
            >
              Guardar regla
            </button>
          </div>
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
