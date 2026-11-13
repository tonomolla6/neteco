<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PackingConfigView, PackingSuggestionView } from '~~/shared/packing-optimizer-api'
import { newCommandId } from '../composables/useDeliveryDriverApp'
import { opsErrorMessage } from '../utils/shipping-ops-errors'
import type { AdminTone } from '~/utils/adminLabels'

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
const statusTone: Record<keyof typeof statusLabel, AdminTone> = {
  suggested: 'warning',
  validated: 'success',
  rejected: 'danger'
}
const hazardLabel: Record<string, string> = {
  none: 'Sin peligro',
  corrosive: 'Corrosivo',
  flammable: 'Inflamable',
  toxic: 'Tóxico',
  oxidizer: 'Comburente',
  irritant: 'Irritante'
}
const dangerousLabel = Object.fromEntries(Object.entries(hazardLabel).filter(([value]) => value !== 'none'))

// Estado de interfaz: pestaña visible y confirmación de borrado.
const activeTab = ref('calculate')
const tabs = computed(() => [
  { value: 'calculate', label: 'Calcular embalaje' },
  { value: 'boxes', label: 'Cajas', count: config.value?.boxes.length ?? null },
  { value: 'profiles', label: 'Productos', count: config.value?.profiles.length ?? null },
  { value: 'rules', label: 'Incompatibilidades', count: config.value?.incompatibilities.length ?? null }
])
const pendingRule = ref<{ classA: string; classB: string } | null>(null)
const confirmRuleOpen = computed({
  get: () => pendingRule.value !== null,
  set: (open: boolean) => {
    if (!open) pendingRule.value = null
  }
})
function confirmDeleteRule() {
  const rule = pendingRule.value
  pendingRule.value = null
  if (rule) void deleteIncomp(rule.classA, rule.classB)
}
function retryConfig() {
  error.value = null
  loading.value = true
  void loadConfig()
}

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
  <div class="adm-stack">
    <div v-if="loading" role="status" aria-live="polite" class="adm-help">Cargando configuración de embalaje…</div>
    <AdminCard v-if="error && !config && !loading">
      <div role="alert">
        <AdminEmptyState
          compact
          variant="error"
          title="No se ha podido cargar la configuración de embalaje"
          :description="error"
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="retryConfig()">Reintentar</AdminButton>
        </AdminEmptyState>
      </div>
    </AdminCard>
    <UAlert v-else-if="error" role="alert" color="error" variant="subtle" :title="error" />

    <template v-if="config">
      <AdminTabs v-model="activeTab" :tabs="tabs" label="Apartados de embalaje" />

      <!-- Cálculo de una propuesta -->
      <div v-show="activeTab === 'calculate'" class="adm-stack">
        <AdminCard
          title="Calcular el embalaje de un pedido"
          description="La propuesta respeta peso, medidas e incompatibilidades. Siempre se valida en almacén con el peso real."
        >
          <form class="space-y-3" @submit.prevent="suggest">
            <AdminFormField
              v-slot="{ id }"
              label="Productos del pedido"
              help="Una línea por producto con el formato «referencia x cantidad». Por ejemplo: LEJIA-5L x 2"
            >
              <textarea :id="id" v-model="linesText" data-test="lines" rows="4" class="adm-input w-full" />
            </AdminFormField>
            <p v-if="linesError" data-test="lines-error" role="alert" class="adm-field__error">{{ linesError }}</p>
            <button
              type="button"
              data-test="suggest"
              :disabled="busy"
              class="adm-btn"
              :class="suggestion?.status === 'suggested' ? 'adm-btn--secondary' : 'adm-btn--primary'"
              @click="suggest"
            >
              Calcular embalaje
            </button>
          </form>
        </AdminCard>

        <AdminCard v-if="suggestion" flush data-test="plan" aria-label="Propuesta de embalaje">
          <template #title>
            <span class="flex flex-wrap items-center gap-2">
              {{ suggestion.plan.totals.parcelCount }}
              {{ suggestion.plan.totals.parcelCount === 1 ? 'bulto' : 'bultos' }} ·
              {{ suggestion.plan.totals.grossWeightGrams.toLocaleString('es-ES') }} g en total
              <AdminBadge :tone="statusTone[suggestion.status]">{{ statusLabel[suggestion.status] }}</AdminBadge>
            </span>
          </template>
          <ol class="adm-list">
            <li v-for="(parcel, index) in suggestion.plan.parcels" :key="index">
              <span class="adm-list__index">{{ index + 1 }}</span>
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">
                  Caja {{ parcel.boxCode }} · {{ parcel.grossWeightGrams.toLocaleString('es-ES') }} g previstos ·
                  ocupación {{ Math.round(parcel.fillRatioBp / 100) }} %
                </p>
                <p class="adm-help">{{ parcel.contents.map((c) => `${c.quantity} × ${c.sku}`).join(', ') }}</p>
                <p v-if="parcel.hazardClasses.some((h) => h !== 'none')" class="mt-1">
                  <AdminBadge tone="warning">
                    Mercancía peligrosa:
                    {{
                      parcel.hazardClasses
                        .filter((h) => h !== 'none')
                        .map((h) => hazardLabel[h] ?? h)
                        .join(', ')
                    }}
                  </AdminBadge>
                </p>
              </div>
              <label v-if="suggestion.status === 'suggested'" class="adm-check">
                Peso real (g)
                <input
                  v-model.number="actual[index]"
                  :data-test="`actual-${index}`"
                  type="number"
                  min="1"
                  class="adm-input w-28"
                />
              </label>
            </li>
          </ol>
          <div v-if="suggestion.status === 'suggested'" class="space-y-3 border-t border-[var(--border)] px-5 py-4">
            <AdminFormField
              v-slot="{ id }"
              label="Motivo del rechazo"
              help="Solo si rechazas la propuesta (mínimo 10 caracteres)."
            >
              <input :id="id" v-model="rejectNote" data-test="reject-note" maxlength="500" class="adm-input w-full" />
            </AdminFormField>
            <p v-if="rejectError" data-test="reject-error" role="alert" class="adm-field__error">{{ rejectError }}</p>
            <div class="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                data-test="reject"
                :disabled="busy"
                class="adm-btn adm-btn--danger-soft"
                @click="decide('reject')"
              >
                Rechazar propuesta
              </button>
              <button
                type="button"
                data-test="accept"
                :disabled="busy"
                class="adm-btn adm-btn--primary"
                @click="decide('accept')"
              >
                Validar en almacén
              </button>
            </div>
          </div>
        </AdminCard>
      </div>

      <!-- Cajas -->
      <section v-show="activeTab === 'boxes'" aria-labelledby="boxes-title" class="adm-stack">
        <AdminCard flush>
          <template #title><span id="boxes-title">Cajas disponibles</span></template>
          <AdminEmptyState
            v-if="!config.boxes.length"
            compact
            icon="i-lucide-package"
            title="Todavía no hay cajas"
            description="Añade la primera con el formulario de abajo."
          />
          <div v-else class="adm-table-wrap">
            <table class="adm-table">
              <thead>
                <tr>
                  <th scope="col">Código</th>
                  <th scope="col">Nombre</th>
                  <th scope="col">Medidas (mm)</th>
                  <th scope="col" data-numeric>Peso máximo</th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in config.boxes" :key="b.code">
                  <td class="font-semibold text-[var(--text-strong)]">{{ b.code }}</td>
                  <td>{{ b.name }}</td>
                  <td>{{ b.widthMm }} × {{ b.heightMm }} × {{ b.depthMm }}</td>
                  <td data-numeric>{{ b.maxWeightGrams.toLocaleString('es-ES') }} g</td>
                  <td>
                    <span class="flex flex-wrap gap-1.5">
                      <AdminBadge :tone="b.active ? 'success' : 'neutral'">
                        {{ b.active ? 'Activa' : 'Inactiva' }}
                      </AdminBadge>
                      <AdminBadge v-if="!b.hazmatAllowed" tone="warning">Sin mercancía peligrosa</AdminBadge>
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>

        <AdminCard title="Añadir o modificar una caja" description="Si el código ya existe, se actualizan sus datos.">
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Código" required>
              <input :id="id" v-model="newBox.code" data-test="new-box-code" placeholder="Ej.: S" class="adm-input" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Nombre" required>
              <input :id="id" v-model="newBox.name" data-test="new-box-name" class="adm-input" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Ancho (mm)">
              <input
                :id="id"
                v-model.number="newBox.widthMm"
                data-test="new-box-width"
                type="number"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Alto (mm)">
              <input
                :id="id"
                v-model.number="newBox.heightMm"
                data-test="new-box-height"
                type="number"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Fondo (mm)">
              <input
                :id="id"
                v-model.number="newBox.depthMm"
                data-test="new-box-depth"
                type="number"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Peso de la caja vacía (g)">
              <input
                :id="id"
                v-model.number="newBox.tareGrams"
                data-test="new-box-tare"
                type="number"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Peso máximo (g)">
              <input
                :id="id"
                v-model.number="newBox.maxWeightGrams"
                data-test="new-box-max-weight"
                type="number"
                class="adm-input"
              />
            </AdminFormField>
          </div>
          <label class="adm-check mt-4">
            <input v-model="newBox.hazmatAllowed" type="checkbox" /> Admite mercancía peligrosa
          </label>
          <template #footer>
            <button
              type="button"
              data-test="save-box-btn"
              :disabled="busy || !newBox.code || !newBox.name"
              class="adm-btn adm-btn--primary"
              @click="saveBox"
            >
              Guardar caja
            </button>
          </template>
        </AdminCard>
      </section>

      <!-- Peso y medidas de los productos -->
      <section v-show="activeTab === 'profiles'" aria-labelledby="profiles-title" class="adm-stack">
        <AdminCard flush>
          <template #title><span id="profiles-title">Peso y medidas de los productos</span></template>
          <AdminEmptyState
            v-if="!config.profiles.length"
            compact
            icon="i-lucide-ruler"
            title="Todavía no hay productos con medidas"
            description="Añade el peso y las medidas de cada referencia para poder calcular su embalaje."
          />
          <div v-else class="adm-table-wrap">
            <table class="adm-table">
              <thead>
                <tr>
                  <th scope="col">Referencia</th>
                  <th scope="col" data-numeric>Peso</th>
                  <th scope="col">Medidas (mm)</th>
                  <th scope="col">Peligrosidad</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in config.profiles" :key="p.sku">
                  <td class="font-semibold text-[var(--text-strong)]">{{ p.sku }}</td>
                  <td data-numeric>{{ p.weightGrams.toLocaleString('es-ES') }} g</td>
                  <td>{{ p.widthMm }} × {{ p.heightMm }} × {{ p.depthMm }}</td>
                  <td>
                    <AdminBadge :tone="p.hazardClass === 'none' ? 'neutral' : 'warning'">
                      {{ hazardLabel[p.hazardClass] ?? p.hazardClass }}
                    </AdminBadge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>

        <AdminCard
          title="Añadir o modificar un producto"
          description="Si la referencia ya existe, se actualizan sus datos."
        >
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Referencia" required>
              <input :id="id" v-model="newProfile.sku" data-test="new-profile-sku" class="adm-input" />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Peso (g)">
              <input
                :id="id"
                v-model.number="newProfile.weightGrams"
                data-test="new-profile-weight"
                type="number"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Ancho (mm)">
              <input
                :id="id"
                v-model.number="newProfile.widthMm"
                data-test="new-profile-width"
                type="number"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Alto (mm)">
              <input
                :id="id"
                v-model.number="newProfile.heightMm"
                data-test="new-profile-height"
                type="number"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Fondo (mm)">
              <input
                :id="id"
                v-model.number="newProfile.depthMm"
                data-test="new-profile-depth"
                type="number"
                class="adm-input"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Peligrosidad">
              <select :id="id" v-model="newProfile.hazardClass" data-test="new-profile-hazard" class="adm-input">
                <option v-for="(label, value) in hazardLabel" :key="value" :value="value">{{ label }}</option>
              </select>
            </AdminFormField>
          </div>
          <template #footer>
            <button
              type="button"
              data-test="save-profile-btn"
              :disabled="busy || !newProfile.sku"
              class="adm-btn adm-btn--primary"
              @click="saveProfile"
            >
              Guardar producto
            </button>
          </template>
        </AdminCard>
      </section>

      <!-- Incompatibilidades -->
      <section v-show="activeTab === 'rules'" aria-labelledby="rules-title" class="adm-stack">
        <AdminCard flush>
          <template #title><span id="rules-title">Productos que no pueden viajar juntos</span></template>
          <AdminEmptyState
            v-if="!config.incompatibilities.length"
            compact
            icon="i-lucide-shield-alert"
            title="No hay incompatibilidades definidas"
          />
          <ul v-else class="adm-list">
            <li v-for="r in config.incompatibilities" :key="`${r.classA}-${r.classB}`">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">
                  {{ hazardLabel[r.classA] ?? r.classA }} + {{ hazardLabel[r.classB] ?? r.classB }}
                </p>
                <p class="adm-help">{{ r.reason }}</p>
              </div>
              <AdminButton
                variant="ghost"
                size="sm"
                icon="i-lucide-trash-2"
                label="Quitar incompatibilidad"
                :disabled="busy"
                @click="pendingRule = { classA: r.classA, classB: r.classB }"
              />
            </li>
          </ul>
        </AdminCard>

        <AdminCard title="Añadir una incompatibilidad">
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Primera clase" required>
              <select :id="id" v-model="newIncomp.classA" data-test="new-incomp-a" class="adm-input">
                <option value="" disabled>Elige una clase</option>
                <option v-for="(label, value) in dangerousLabel" :key="value" :value="value">{{ label }}</option>
              </select>
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Segunda clase" required>
              <select :id="id" v-model="newIncomp.classB" data-test="new-incomp-b" class="adm-input">
                <option value="" disabled>Elige una clase</option>
                <option v-for="(label, value) in dangerousLabel" :key="value" :value="value">{{ label }}</option>
              </select>
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Motivo" required>
              <input :id="id" v-model="newIncomp.reason" data-test="new-incomp-reason" class="adm-input" />
            </AdminFormField>
          </div>
          <template #footer>
            <button
              type="button"
              data-test="save-incomp-btn"
              :disabled="busy || !newIncomp.classA || !newIncomp.classB || !newIncomp.reason"
              class="adm-btn adm-btn--primary"
              @click="saveIncompatibility"
            >
              Guardar incompatibilidad
            </button>
          </template>
        </AdminCard>
      </section>
    </template>

    <AdminConfirm
      v-model:open="confirmRuleOpen"
      title="¿Quitar esta incompatibilidad?"
      description="A partir de ahora estos productos podrán proponerse en el mismo bulto."
      confirm-label="Quitar"
      danger
      @confirm="confirmDeleteRule"
    />
  </div>
</template>
