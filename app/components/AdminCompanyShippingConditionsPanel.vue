<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { CompanyShippingConditions, CompanyShippingMethodCode } from '~~/shared/company-shipping-conditions'

const props = defineProps<{
  companyId: string
}>()

const emit = defineEmits<{
  (e: 'saved', conditions: CompanyShippingConditions): void
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)

const form = ref({
  customMethodsEnabled: true,
  allowedMethods: ['pickup', 'own_delivery', 'parcel'] as CompanyShippingMethodCode[],
  carrierAccountCarrier: '',
  carrierAccountNumber: '',
  warehousePickupAllowed: true,
  freeShippingThresholdEuros: '' as string | number,
  customDeliveryInstructions: '',
  version: 0
})

async function fetchConditions() {
  loading.value = true
  error.value = null
  try {
    const res = await requestFetch<{ conditions: CompanyShippingConditions }>(
      `/api/admin/companies/${props.companyId}/shipping-conditions`
    )
    if (res?.conditions) {
      const c = res.conditions
      form.value = {
        customMethodsEnabled: c.customMethodsEnabled,
        allowedMethods: [...c.allowedMethods],
        carrierAccountCarrier: c.carrierAccountCarrier || '',
        carrierAccountNumber: c.carrierAccountNumber || '',
        warehousePickupAllowed: c.warehousePickupAllowed,
        freeShippingThresholdEuros: c.freeShippingThresholdCents !== null ? c.freeShippingThresholdCents / 100 : '',
        customDeliveryInstructions: c.customDeliveryInstructions || '',
        version: c.version
      }
    }
  } catch {
    error.value = 'No se han podido cargar las condiciones de envío de la empresa.'
  } finally {
    loading.value = false
  }
}

async function handleSave() {
  saving.value = true
  error.value = null
  successMessage.value = null

  const thresholdEuros = Number.parseFloat(String(form.value.freeShippingThresholdEuros))
  const freeShippingThresholdCents =
    Number.isFinite(thresholdEuros) && thresholdEuros >= 0 ? Math.round(thresholdEuros * 100) : null

  const commandId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `cmd-${Date.now()}`

  try {
    const res = await requestFetch<{ conditions: CompanyShippingConditions }>(
      `/api/admin/companies/${props.companyId}/shipping-conditions`,
      {
        method: 'PUT',
        body: {
          companyId: props.companyId,
          customMethodsEnabled: form.value.customMethodsEnabled,
          allowedMethods: form.value.allowedMethods,
          carrierAccountCarrier: form.value.carrierAccountCarrier.trim() || null,
          carrierAccountNumber: form.value.carrierAccountNumber.trim() || null,
          warehousePickupAllowed: form.value.warehousePickupAllowed,
          freeShippingThresholdCents,
          customDeliveryInstructions: form.value.customDeliveryInstructions.trim() || null,
          expectedVersion: form.value.version,
          commandId
        }
      }
    )

    if (res?.conditions) {
      form.value.version = res.conditions.version
      successMessage.value = 'Condiciones guardadas correctamente'
      emit('saved', res.conditions)
    }
  } catch (err: unknown) {
    const errorObject = err && typeof err === 'object' ? (err as Record<string, unknown>) : null
    const errorData =
      errorObject?.data && typeof errorObject.data === 'object' ? (errorObject.data as Record<string, unknown>) : null
    const nestedError =
      errorData?.error && typeof errorData.error === 'object' ? (errorData.error as Record<string, unknown>) : null
    const code = nestedError?.code ?? errorObject?.statusCode

    if (code === 409 || code === 'version_conflict') {
      error.value =
        'Conflicto de versiones: otro operador ha modificado estas condiciones simultáneamente. Recarga la página.'
    } else {
      error.value =
        (typeof nestedError?.message === 'string' ? nestedError.message : null) ||
        'Error al guardar las condiciones de envío.'
    }
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void fetchConditions()
})
</script>

<template>
  <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
    <div class="border-b border-slate-100 pb-4">
      <h3 class="text-lg font-semibold text-slate-900">Condiciones de envío B2B (Empresa)</h3>
      <p class="text-xs text-slate-500">
        Configura métodos de entrega autorizados, cuenta de portes y condiciones comerciales para esta empresa.
      </p>
    </div>

    <!-- Loading State -->
    <div
      v-if="loading"
      role="status"
      aria-live="polite"
      class="flex items-center justify-center p-8 text-sm text-slate-500"
    >
      <svg
        class="mr-2 h-5 w-5 animate-spin text-slate-400"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path
          class="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        ></path>
      </svg>
      Cargando condiciones de envío...
    </div>

    <form v-else class="mt-5 space-y-6" @submit.prevent="handleSave">
      <!-- Alerts -->
      <div v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {{ error }}
      </div>
      <div
        v-if="successMessage"
        role="status"
        class="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
      >
        {{ successMessage }}
      </div>

      <!-- Methods Selection -->
      <fieldset class="space-y-3">
        <legend class="text-sm font-medium text-slate-900">Métodos de entrega permitidos</legend>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label class="flex items-center space-x-2 text-sm text-slate-700">
            <input
              v-model="form.allowedMethods"
              type="checkbox"
              value="pickup"
              class="h-4 w-4 rounded border-slate-300 text-neteco-600 focus:ring-neteco-500"
            />
            <span>Recogida en almacén central</span>
          </label>
          <label class="flex items-center space-x-2 text-sm text-slate-700">
            <input
              v-model="form.allowedMethods"
              type="checkbox"
              value="own_delivery"
              class="h-4 w-4 rounded border-slate-300 text-neteco-600 focus:ring-neteco-500"
            />
            <span>Reparto propio comarcal</span>
          </label>
          <label class="flex items-center space-x-2 text-sm text-slate-700">
            <input
              v-model="form.allowedMethods"
              type="checkbox"
              value="parcel"
              class="h-4 w-4 rounded border-slate-300 text-neteco-600 focus:ring-neteco-500"
            />
            <span>Transporte estándar peninsular</span>
          </label>
          <label class="flex items-center space-x-2 text-sm text-slate-700">
            <input
              v-model="form.allowedMethods"
              type="checkbox"
              value="carrier_customer_account"
              class="h-4 w-4 rounded border-slate-300 text-neteco-600 focus:ring-neteco-500"
            />
            <span>Cuenta de portes propios (debidos)</span>
          </label>
        </div>
      </fieldset>

      <!-- Carrier Account Section -->
      <div class="rounded-lg border border-slate-100 bg-slate-50 p-4 space-y-4">
        <h4 class="text-sm font-semibold text-slate-900">Cuenta de portes del cliente</h4>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label for="carrierAccountCarrier" class="block text-xs font-medium text-slate-700">
              Transportista concertado
            </label>
            <input
              id="carrierAccountCarrier"
              v-model="form.carrierAccountCarrier"
              name="carrierAccountCarrier"
              type="text"
              placeholder="p. ej. SEUR, DHL, Correos Express"
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-neteco-500 focus:outline-none focus:ring-1 focus:ring-neteco-500"
            />
          </div>
          <div>
            <label for="carrierAccountNumber" class="block text-xs font-medium text-slate-700">
              Número de cuenta de portes
            </label>
            <input
              id="carrierAccountNumber"
              v-model="form.carrierAccountNumber"
              name="carrierAccountNumber"
              type="text"
              placeholder="p. ej. ACC-98765432"
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-neteco-500 focus:outline-none focus:ring-1 focus:ring-neteco-500"
            />
          </div>
        </div>
      </div>

      <!-- Threshold and Instructions -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label for="freeShippingThresholdEuros" class="block text-xs font-medium text-slate-700">
            Umbral de portes gratuitos personalizados (€)
          </label>
          <input
            id="freeShippingThresholdEuros"
            v-model="form.freeShippingThresholdEuros"
            name="freeShippingThresholdEuros"
            type="number"
            step="0.01"
            min="0"
            placeholder="Dejar vacío para política estándar"
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-neteco-500 focus:outline-none focus:ring-1 focus:ring-neteco-500"
          />
        </div>
        <div>
          <label for="customDeliveryInstructions" class="block text-xs font-medium text-slate-700">
            Instrucciones habituales de entrega
          </label>
          <textarea
            id="customDeliveryInstructions"
            v-model="form.customDeliveryInstructions"
            name="customDeliveryInstructions"
            rows="2"
            placeholder="Muelle de carga, horario preferente de recepción..."
            class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-neteco-500 focus:outline-none focus:ring-1 focus:ring-neteco-500"
          ></textarea>
        </div>
      </div>

      <!-- Submit Button -->
      <div class="flex items-center justify-end space-x-3 border-t border-slate-100 pt-4">
        <span class="text-xs text-slate-400">Versión actual: {{ form.version }}</span>
        <button
          type="submit"
          :disabled="saving"
          class="inline-flex items-center rounded-lg bg-neteco-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-neteco-700 focus:outline-none focus:ring-2 focus:ring-neteco-500 focus:ring-offset-2 disabled:opacity-50"
        >
          <span v-if="saving">Guardando...</span>
          <span v-else>Guardar condiciones</span>
        </button>
      </div>
    </form>
  </div>
</template>
