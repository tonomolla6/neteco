<script setup lang="ts">
import { ref, onMounted } from 'vue'

const requestFetch = useRequestFetch()

interface VisibleManagerResponse {
  hasAssignedManager: boolean
  manager?: {
    name: string
    email: string
    phone: string | null
    availabilitySchedule: string
    slaTier: string
    slaResponseHours: number
    slaDescription?: string
  }
  generalSupport: {
    email: string
    phone: string
    hours: string
  }
}

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<VisibleManagerResponse | null>(null)

async function fetchAccountManager() {
  loading.value = true
  error.value = null

  try {
    const res = await requestFetch<VisibleManagerResponse>('/api/customer/account-manager')
    data.value = res
  } catch {
    error.value = 'No se ha podido cargar la información de contacto de tu gestor de cuenta.'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void fetchAccountManager()
})
</script>

<template>
  <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
    <div v-if="loading" class="text-sm text-slate-500">Cargando gestor de cuenta asignado...</div>
    <div v-else-if="error" class="text-sm text-rose-600">{{ error }}</div>

    <!-- Assigned dedicated manager -->
    <div v-else-if="data && data.hasAssignedManager && data.manager" class="space-y-4">
      <div class="flex items-center justify-between border-b border-slate-100 pb-3">
        <div>
          <span class="text-xs font-semibold uppercase tracking-wider text-indigo-600"
            >Gestor comercial y de cuenta</span
          >
          <h3 class="text-lg font-bold text-slate-900">{{ data.manager.name }}</h3>
        </div>
        <span class="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 uppercase">
          SLA {{ data.manager.slaTier }} ({{ data.manager.slaResponseHours }} horas)
        </span>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
        <div>
          <span class="block text-xs font-medium text-slate-500">Email directo</span>
          <a :href="`mailto:${data.manager.email}`" class="text-indigo-600 hover:underline font-medium">
            {{ data.manager.email }}
          </a>
        </div>
        <div v-if="data.manager.phone">
          <span class="block text-xs font-medium text-slate-500">Teléfono directo</span>
          <span class="text-slate-900 font-medium">{{ data.manager.phone }}</span>
        </div>
        <div>
          <span class="block text-xs font-medium text-slate-500">Horario de atención</span>
          <span class="text-slate-700">{{ data.manager.availabilitySchedule }}</span>
        </div>
        <div>
          <span class="block text-xs font-medium text-slate-500">Compromiso de servicio</span>
          <span class="text-slate-700"
            >Respuesta garantizada en {{ data.manager.slaResponseHours }} horas laborables</span
          >
        </div>
      </div>

      <div
        v-if="data.manager.slaDescription"
        class="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 border border-slate-100"
      >
        {{ data.manager.slaDescription }}
      </div>
    </div>

    <!-- Fallback general support when unassigned -->
    <div v-else-if="data && !data.hasAssignedManager" class="space-y-3">
      <div class="border-b border-slate-100 pb-2">
        <span class="text-xs font-semibold uppercase tracking-wider text-slate-500">Atención al cliente y soporte</span>
        <h3 class="text-base font-semibold text-slate-900">Canales de atención directa</h3>
      </div>
      <p class="text-xs text-slate-600">
        Tu cuenta dispone de atención general por nuestro equipo de soporte técnico y comercial.
      </p>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm pt-1">
        <div>
          <span class="block text-xs font-medium text-slate-500">Email de soporte</span>
          <a :href="`mailto:${data.generalSupport.email}`" class="text-indigo-600 hover:underline font-medium">
            {{ data.generalSupport.email }}
          </a>
        </div>
        <div>
          <span class="block text-xs font-medium text-slate-500">Teléfono centralita</span>
          <span class="text-slate-900 font-medium">{{ data.generalSupport.phone }}</span>
        </div>
      </div>
      <div class="text-xs text-slate-500 pt-2 border-t border-slate-100">Horario: {{ data.generalSupport.hours }}</div>
    </div>
  </div>
</template>
