<script setup lang="ts">
import { ref, onMounted } from 'vue'

const requestFetch = useRequestFetch()

interface AudienceCondition {
  field: string
  operator: string
  value: string | number | boolean
}

interface AudienceSegment {
  id: string
  slug: string
  name: string
  description?: string
  version: number
  targetType: 'all' | 'b2b' | 'b2c'
  rules: {
    logic: string
    conditions: AudienceCondition[]
  }
  estimatedTotalUsers: number
  estimatedConsentedUsers: number
  status: string
}

interface UserPreview {
  id: string
  maskedIdentifier: string
  customerType: string
  hasConsent: boolean
  orderCount: number
  totalSpentCents: number
  daysSinceLastOrder?: number
}

const loading = ref(false)
const calculating = ref(false)
const errorMessage = ref('')
const segments = ref<AudienceSegment[]>([])
const activeSegment = ref<AudienceSegment | null>(null)
const estimationResult = ref<{
  totalMatchingUsers: number
  consentedUsers: number
  unconsentedUsers: number
  consentPercentage: number
} | null>(null)
const previewUsers = ref<UserPreview[]>([])
const showCreateModal = ref(false)

const newSegment = ref({
  slug: '',
  name: '',
  description: '',
  targetType: 'all' as const,
  conditionField: 'customer_type',
  conditionOp: 'eq',
  conditionValue: 'b2b'
})

async function loadSegments() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/audiences')) as { items: AudienceSegment[] }
    segments.value = res?.items ?? []
    if (segments.value.length > 0 && !activeSegment.value) {
      activeSegment.value = segments.value[0]!
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar segmentos de audiencia'
  } finally {
    loading.value = false
  }
}

async function estimateActiveAudience() {
  if (!activeSegment.value) return
  calculating.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch(`/api/admin/audiences/${activeSegment.value.id}/estimate`, {
      method: 'POST'
    })) as {
      totalMatchingUsers: number
      consentedUsers: number
      unconsentedUsers: number
      consentPercentage: number
    }
    estimationResult.value = res
    activeSegment.value.estimatedTotalUsers = res.totalMatchingUsers
    activeSegment.value.estimatedConsentedUsers = res.consentedUsers
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al calcular estimación de tamaño y consentimiento'
  } finally {
    calculating.value = false
  }
}

async function previewActiveAudience() {
  if (!activeSegment.value) return
  calculating.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch(`/api/admin/audiences/${activeSegment.value.id}/preview?limit=10`)) as {
      items: UserPreview[]
    }
    previewUsers.value = res?.items ?? []
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al obtener vista previa protegida de usuarios'
  } finally {
    calculating.value = false
  }
}

async function createSegment() {
  loading.value = true
  errorMessage.value = ''
  try {
    await requestFetch('/api/admin/audiences', {
      method: 'POST',
      body: {
        slug: newSegment.value.slug,
        name: newSegment.value.name,
        description: newSegment.value.description,
        targetType: newSegment.value.targetType,
        rules: {
          logic: 'AND',
          conditions: [
            {
              field: newSegment.value.conditionField,
              operator: newSegment.value.conditionOp,
              value: newSegment.value.conditionValue
            }
          ]
        }
      }
    })
    showCreateModal.value = false
    await loadSegments()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al crear el segmento'
  } finally {
    loading.value = false
  }
}

function selectSegment(seg: AudienceSegment) {
  activeSegment.value = seg
  estimationResult.value = null
  previewUsers.value = []
}

onMounted(() => {
  loadSegments()
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between border-b pb-4">
      <div>
        <h2 class="text-xl font-bold tracking-tight text-slate-900">Segmentos y Audiencias (ADM-027)</h2>
        <p class="text-sm text-slate-500">
          Reglas versionadas, estimación de tamaño y consentimiento previsto, con previsualización protegida contra fuga
          de PII.
        </p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-neteco-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-neteco-700"
        @click="showCreateModal = !showCreateModal"
      >
        Nuevo Segmento
      </button>
    </div>

    <!-- Error state -->
    <div v-if="errorMessage" role="alert" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">
      {{ errorMessage }}
    </div>

    <!-- Modal Create -->
    <div v-if="showCreateModal" class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h3 class="mb-4 text-base font-semibold text-slate-900">Definir Nuevo Segmento de Clientes</h3>
      <form class="space-y-4" @submit.prevent="createSegment">
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-500">Slug Identificador</label>
            <input
              v-model="newSegment.slug"
              type="text"
              required
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              placeholder="ej: hosteleria-valencia"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-500">Nombre del Segmento</label>
            <input
              v-model="newSegment.name"
              type="text"
              required
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              placeholder="ej: Hostelería y Restauración Valencia"
            />
          </div>
        </div>

        <div>
          <label class="block text-xs font-semibold uppercase text-slate-500">Audiencia Objetivo</label>
          <select
            v-model="newSegment.targetType"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="all">Todos los clientes (B2B + B2C)</option>
            <option value="b2b">Solo Clientes B2B (Empresas)</option>
            <option value="b2c">Solo Clientes B2C (Particulares)</option>
          </select>
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <button
            type="button"
            class="rounded-lg border px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            @click="showCreateModal = false"
          >
            Cancelar
          </button>
          <button
            type="submit"
            class="rounded-lg bg-neteco-600 px-4 py-2 text-sm font-semibold text-white hover:bg-neteco-700"
          >
            Guardar Segmento (v1)
          </button>
        </div>
      </form>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="p-8 text-center text-sm text-slate-500">Cargando audiencias y reglas versionadas...</div>

    <!-- Empty State -->
    <div v-else-if="segments.length === 0" class="rounded-xl border border-dashed border-slate-300 p-8 text-center">
      <p class="text-sm font-medium text-slate-600">No hay segmentos de audiencia creados.</p>
    </div>

    <!-- Segments Table & Operations -->
    <div v-else class="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <!-- List Column -->
      <div class="space-y-3 lg:col-span-1">
        <div
          v-for="seg in segments"
          :key="seg.id"
          class="cursor-pointer rounded-xl border p-4 transition-all"
          :class="
            activeSegment?.id === seg.id
              ? 'border-neteco-600 bg-neteco-50/40 shadow-sm'
              : 'border-slate-200 bg-white hover:border-slate-300'
          "
          @click="selectSegment(seg)"
        >
          <div class="flex items-center justify-between">
            <h4 class="text-sm font-bold text-slate-900">{{ seg.name }}</h4>
            <span class="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
              v{{ seg.version }}
            </span>
          </div>
          <p class="mt-1 text-xs text-slate-500 line-clamp-2">{{ seg.description || 'Sin descripción' }}</p>
          <div class="mt-3 flex items-center justify-between text-xs text-slate-600">
            <span
              >Estimados: <strong class="text-slate-900">{{ seg.estimatedTotalUsers }}</strong></span
            >
            <span class="capitalize text-slate-500">{{ seg.targetType }}</span>
          </div>
        </div>
      </div>

      <!-- Detail & Actions Column -->
      <div v-if="activeSegment" class="space-y-6 lg:col-span-2">
        <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
            <div>
              <h3 class="text-base font-bold text-slate-900">{{ activeSegment.name }}</h3>
              <p class="text-xs font-mono text-slate-400">
                slug: {{ activeSegment.slug }} · Versión de reglas: v{{ activeSegment.version }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button
                data-test="estimate-audience"
                type="button"
                :disabled="calculating"
                class="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                @click="estimateActiveAudience"
              >
                {{ calculating ? 'Calculando...' : 'Calcular Estimación' }}
              </button>
              <button
                data-test="preview-audience"
                type="button"
                :disabled="calculating"
                class="inline-flex items-center rounded-lg bg-neteco-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neteco-700 disabled:opacity-50"
                @click="previewActiveAudience"
              >
                Preview Seguro (GDPR)
              </button>
            </div>
          </div>

          <!-- Estimation Metric Cards -->
          <div v-if="estimationResult" class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div class="rounded-lg bg-slate-50 p-3">
              <span class="text-[11px] text-slate-500">Usuarios Totales</span>
              <p class="text-lg font-bold text-slate-900">{{ estimationResult.totalMatchingUsers }}</p>
            </div>
            <div class="rounded-lg bg-emerald-50 p-3">
              <span class="text-[11px] text-emerald-700">Con Consentimiento</span>
              <p class="text-lg font-bold text-emerald-800">{{ estimationResult.consentedUsers }}</p>
            </div>
            <div class="rounded-lg bg-amber-50 p-3">
              <span class="text-[11px] text-amber-700">Sin Consentimiento</span>
              <p class="text-lg font-bold text-amber-800">{{ estimationResult.unconsentedUsers }}</p>
            </div>
            <div class="rounded-lg bg-blue-50 p-3">
              <span class="text-[11px] text-blue-700">% Consentimiento</span>
              <p class="text-lg font-bold text-blue-800">{{ estimationResult.consentPercentage }}%</p>
            </div>
          </div>

          <!-- User Preview List with PII Safe Masking -->
          <div v-if="previewUsers.length > 0" class="mt-5 border-t pt-4">
            <h4 class="mb-3 text-xs font-bold uppercase tracking-wider text-slate-600">
              Vista Previa de Destinatarios (PII Anonimizada)
            </h4>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead>
                  <tr class="border-b text-slate-400">
                    <th class="py-2">Identificador</th>
                    <th class="py-2">Tipo</th>
                    <th class="py-2">Pedidos</th>
                    <th class="py-2">Gasto Acumulado</th>
                    <th class="py-2">Consentimiento</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  <tr v-for="user in previewUsers" :key="user.id">
                    <td class="py-2 font-mono text-slate-800">{{ user.maskedIdentifier }}</td>
                    <td class="py-2 uppercase text-slate-500">{{ user.customerType }}</td>
                    <td class="py-2 text-slate-700">{{ user.orderCount }}</td>
                    <td class="py-2 text-slate-700">{{ (user.totalSpentCents / 100).toFixed(2) }}€</td>
                    <td class="py-2">
                      <span
                        class="rounded-full px-2 py-0.5 text-[10px] font-bold"
                        :class="user.hasConsent ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'"
                      >
                        {{ user.hasConsent ? 'Activo' : 'No consentido' }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
