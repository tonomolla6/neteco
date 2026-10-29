<script setup lang="ts">
import { ref, onMounted } from 'vue'

const requestFetch = useRequestFetch()

interface PreventiveActionItem {
  id: string
  actionType: string
  description: string
  assignee: string
  targetDate: string
  status: string
  completedAt?: string
}

interface RcaItem {
  id: string
  publicRef: string
  incidentCategory: 'damage' | 'picking_error' | 'delay' | 'stock_discrepancy' | 'documentation'
  title: string
  status: string
  severity: string
  rootCauseSummary: string
  fiveWhys: string[]
  preventiveActions: PreventiveActionItem[]
  verificationStatus: string
  verifiedAt?: string
  verificationNotes?: string
  version: number
  createdAt: string
}

const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const items = ref<RcaItem[]>([])
const isCreating = ref(false)

const form = ref({
  incidentCategory: 'damage' as RcaItem['incidentCategory'],
  title: '',
  severity: 'high' as const,
  rootCauseSummary: '',
  why1: '',
  why2: '',
  why3: '',
  why4: '',
  why5: '',
  actionType: 'packaging_update',
  actionDescription: '',
  actionAssignee: '',
  actionTargetDate: '2026-11-15T00:00:00Z'
})

const categoryLabels: Record<RcaItem['incidentCategory'], string> = {
  damage: 'Daño en mercancía',
  picking_error: 'Error de picking',
  delay: 'Atraso / Retraso',
  stock_discrepancy: 'Descuadre de stock',
  documentation: 'Documentación / Etiquetado'
}

async function loadRcas() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/support/rca')) as { items: RcaItem[] }
    items.value = res?.items ?? []
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar los análisis RCA'
  } finally {
    loading.value = false
  }
}

async function submitRca() {
  saving.value = true
  errorMessage.value = ''
  try {
    const whys = [form.value.why1, form.value.why2, form.value.why3, form.value.why4, form.value.why5].filter(Boolean)
    const preventiveActions: PreventiveActionItem[] = []
    if (form.value.actionDescription) {
      preventiveActions.push({
        id: crypto.randomUUID(),
        actionType: form.value.actionType,
        description: form.value.actionDescription,
        assignee: form.value.actionAssignee || 'Responsable de Calidad',
        targetDate: form.value.actionTargetDate,
        status: 'pending'
      })
    }

    await requestFetch('/api/admin/support/rca', {
      method: 'POST',
      body: {
        incidentCategory: form.value.incidentCategory,
        title: form.value.title || 'Incidencia de calidad operativa',
        severity: form.value.severity,
        rootCauseSummary: form.value.rootCauseSummary || 'Análisis sistemático de causa raíz',
        fiveWhys: whys.length > 0 ? whys : ['Causa primaria identificada'],
        preventiveActions
      }
    })

    successMessage.value = 'RCA y plan preventivo creados correctamente'
    isCreating.value = false
    await loadRcas()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al registrar el RCA'
  } finally {
    saving.value = false
  }
}

async function verifyRca(rca: RcaItem) {
  saving.value = true
  errorMessage.value = ''
  try {
    await requestFetch(`/api/admin/support/rca/${rca.id}/verify`, {
      method: 'POST',
      body: {
        expectedVersion: rca.version,
        verificationStatus: 'verified_effective',
        verificationNotes: 'Verificación realizada en almacén: medidas correctoras efectivas sin recurrencias.'
      }
    })
    rca.verificationStatus = 'verified_effective'
    rca.status = 'verified'
    successMessage.value = 'Acciones preventivas verificadas con éxito'
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al verificar eficacia'
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadRcas()
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between border-b pb-4">
      <div>
        <h2 class="text-xl font-bold tracking-tight text-slate-900">Análisis de Causa Raíz (RCA)</h2>
        <p class="text-sm text-slate-500">
          SUP-018: Metodología sistemática para incidencias de daño, error de picking, atraso, stock y documentación.
        </p>
      </div>
      <button
        data-test="open-create-rca"
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-neteco-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-neteco-700"
        @click="isCreating = !isCreating"
      >
        {{ isCreating ? 'Cancelar' : 'Nuevo RCA Operativo' }}
      </button>
    </div>

    <!-- Alert / Messages -->
    <div v-if="errorMessage" role="alert" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">
      {{ errorMessage }}
    </div>
    <div v-if="successMessage" role="status" class="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-700">
      {{ successMessage }}
    </div>

    <!-- Create Form -->
    <div v-if="isCreating" class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h3 class="mb-4 text-base font-semibold text-slate-900">Registrar Análisis de Incidencia Operativa</h3>
      <form class="space-y-4" @submit.prevent="submitRca">
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-500">Categoría Obligatoria</label>
            <select
              v-model="form.incidentCategory"
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              required
            >
              <option value="damage">Daño (Rotura / embalaje)</option>
              <option value="picking_error">Error de picking</option>
              <option value="delay">Atraso en expedición</option>
              <option value="stock_discrepancy">Descuadre de stock</option>
              <option value="documentation">Documentación / FDS</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-500">Severidad</label>
            <select
              v-model="form.severity"
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="low">Baja</option>
              <option value="medium">Media</option>
              <option value="high">Alta</option>
              <option value="critical">Crítica</option>
            </select>
          </div>
        </div>

        <div>
          <label class="block text-xs font-semibold uppercase text-slate-500">Título de la Incidencia</label>
          <input
            v-model="form.title"
            name="rcaTitle"
            type="text"
            required
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Ej: Rotura de garrafas en transporte paletizado"
          />
        </div>

        <div>
          <label class="block text-xs font-semibold uppercase text-slate-500">Causa Raíz Diagnosticada</label>
          <textarea
            v-model="form.rootCauseSummary"
            rows="2"
            required
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Explicación técnica de la causa primaria identificada"
          />
        </div>

        <div class="rounded-lg bg-slate-50 p-4">
          <h4 class="mb-2 text-xs font-bold uppercase text-slate-700">Acción Preventiva / Correctora (CAPA)</h4>
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label class="block text-xs text-slate-500">Tipo de Acción</label>
              <select
                v-model="form.actionType"
                class="mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
              >
                <option value="packaging_update">Cantoneras / Embalaje reforzado</option>
                <option value="process_change">Cambio de proceso</option>
                <option value="training">Formación de operarios</option>
                <option value="inventory_audit">Auditoría de inventario</option>
                <option value="documentation_template">Plantilla documental / FDS</option>
              </select>
            </div>
            <div>
              <label class="block text-xs text-slate-500">Descripción de la Medida Preventiva</label>
              <input
                v-model="form.actionDescription"
                type="text"
                class="mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs"
                placeholder="Ej: Incorporar cantoneras rígidas y fleje calibrado"
              />
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <button
            type="button"
            class="rounded-lg border px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            @click="isCreating = false"
          >
            Cancelar
          </button>
          <button
            data-test="submit-rca"
            type="submit"
            :disabled="saving"
            class="rounded-lg bg-neteco-600 px-4 py-2 text-sm font-semibold text-white hover:bg-neteco-700 disabled:opacity-50"
          >
            {{ saving ? 'Guardando...' : 'Guardar Análisis y Plan' }}
          </button>
        </div>
      </form>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="p-8 text-center text-sm text-slate-500">Cargando registro sistemático de RCA...</div>

    <!-- Empty State -->
    <div v-else-if="items.length === 0" class="rounded-xl border border-dashed border-slate-300 p-8 text-center">
      <p class="text-sm font-medium text-slate-600">No hay análisis RCA registrados todavía.</p>
      <p class="mt-1 text-xs text-slate-400">
        Las incidencias de daño, picking, retrasos o stock deben vincularse a acciones preventivas.
      </p>
    </div>

    <!-- List State -->
    <div v-else class="space-y-4">
      <div
        v-for="rca in items"
        :key="rca.id"
        class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:border-slate-300"
      >
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-2">
              <span class="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600">
                {{ rca.publicRef }}
              </span>
              <span
                class="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700"
              >
                {{ categoryLabels[rca.incidentCategory] || rca.incidentCategory }}
              </span>
              <span
                class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
                :class="
                  rca.verificationStatus === 'verified_effective'
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-amber-50 text-amber-700'
                "
              >
                {{ rca.verificationStatus === 'verified_effective' ? 'Verificado Efectivo' : 'Pendiente Verificación' }}
              </span>
            </div>
            <h3 class="mt-2 text-base font-semibold text-slate-900">{{ rca.title }}</h3>
            <p class="mt-1 text-sm text-slate-600">{{ rca.rootCauseSummary }}</p>
          </div>

          <div class="flex items-center gap-2">
            <button
              v-if="rca.verificationStatus !== 'verified_effective'"
              data-test="verify-rca"
              type="button"
              class="inline-flex items-center rounded-lg border border-emerald-600 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
              @click="verifyRca(rca)"
            >
              Verificar Eficacia
            </button>
            <span v-else class="text-xs font-semibold text-emerald-600"> ✓ Verificado </span>
          </div>
        </div>

        <!-- Preventive Actions Table -->
        <div v-if="rca.preventiveActions && rca.preventiveActions.length > 0" class="mt-4 border-t pt-3">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500">Acciones Preventivas Vinculadas</h4>
          <ul class="mt-2 space-y-1">
            <li
              v-for="act in rca.preventiveActions"
              :key="act.id"
              class="flex items-center justify-between text-xs text-slate-700"
            >
              <span>• {{ act.description }} ({{ act.actionType }})</span>
              <span class="font-medium text-slate-500">Resp: {{ act.assignee }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
