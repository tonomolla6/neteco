<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { CustomerReferralOverview } from '~~/shared/referrals'

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const overview = ref<CustomerReferralOverview | null>(null)

const termsAccepted = ref(false)
const enrolling = ref(false)
const copied = ref(false)

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
}

async function loadOverview() {
  loading.value = true
  error.value = null
  try {
    const res = (await requestFetch('/api/account/referrals')) as { overview: CustomerReferralOverview }
    overview.value = res.overview
  } catch {
    error.value = 'No se pudo cargar el estado de referidos.'
  } finally {
    loading.value = false
  }
}

async function handleEnroll() {
  if (!termsAccepted.value) return
  enrolling.value = true
  error.value = null
  try {
    await requestFetch<unknown, string>('/api/account/referrals/enroll', {
      method: 'POST',
      body: {
        termsVersion: 'terms-2026-v1'
      }
    })
    await loadOverview()
  } catch {
    error.value = 'Error al inscribirse en el programa de referidos.'
  } finally {
    enrolling.value = false
  }
}

function copyLink() {
  if (!overview.value?.referralCode) return
  const link = `https://tienda.neteco.test/?ref=${overview.value.referralCode}`
  if (navigator?.clipboard) {
    navigator.clipboard.writeText(link)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2500)
  }
}

onMounted(() => {
  loadOverview()
})
</script>

<template>
  <div class="referral-account-panel bg-white border rounded-lg p-6 max-w-2xl">
    <div class="border-b pb-4 mb-6">
      <h2 class="text-xl font-bold text-gray-900">Programa de Referidos</h2>
      <p class="text-sm text-gray-600 mt-1">
        Invita a empresas y profesionales colaboradores. Recibe recompensas directamente en tu cuenta tras cumplirse la
        ventana de devolución reglamentaria de cada pedido.
      </p>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="py-8 text-center text-gray-500 text-sm">Cargando información del programa...</div>

    <!-- Error State -->
    <div v-else-if="error" class="bg-red-50 text-red-700 p-4 rounded mb-4 text-sm">
      {{ error }}
    </div>

    <!-- Not Enrolled: Consent Prompt -->
    <div v-else-if="overview && !overview.enrolled" class="space-y-4">
      <div class="bg-blue-50 border border-blue-200 rounded p-4 text-sm text-blue-900">
        <h3 class="font-bold mb-1">Únete al Programa de Colaboradores</h3>
        <p class="text-xs text-blue-800 mb-3">
          Obtén 15,00 € por cada nuevo cliente profesional que complete su primera compra superior a 50,00 €. El
          referido disfrutará además de 10,00 € de descuento inmediato.
        </p>
        <p class="text-xs text-blue-700">
          * Recompensa consolidada tras 14 días (ventana de devolución sin incidencias). Límite de 10 referidos activos
          por empresa.
        </p>
      </div>

      <div class="border rounded p-4 bg-gray-50 text-xs text-gray-600 max-h-32 overflow-y-auto">
        <h4 class="font-bold text-gray-800 mb-1">Términos y condiciones del programa (versión terms-2026-v1):</h4>
        <p>1. Prohibido el auto-referido mediante identidades o direcciones coincidentes.</p>
        <p>2. Aplicable exclusivamente a nuevas cuentas de clientes verificadas.</p>
        <p>3. Las recompensas se liquidan transcurrida la ventana de devolución sin devoluciones ni reembolsos.</p>
      </div>

      <div class="flex items-center gap-2">
        <input
          id="accept-terms"
          v-model="termsAccepted"
          type="checkbox"
          class="rounded text-blue-600 focus:ring-blue-500 h-4 w-4"
        />
        <label for="accept-terms" class="text-sm text-gray-700">
          Acepto los términos y condiciones del programa de referidos.
        </label>
      </div>

      <button
        type="button"
        data-testid="enroll-btn"
        class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded text-sm disabled:opacity-50 transition"
        :disabled="!termsAccepted || enrolling"
        @click="handleEnroll"
      >
        {{ enrolling ? 'Inscribiendo...' : 'Activar mi código de referido' }}
      </button>
    </div>

    <!-- Enrolled Dashboard -->
    <div v-else-if="overview && overview.enrolled" class="space-y-6">
      <!-- Referral code and link -->
      <div class="bg-gray-50 border rounded p-4">
        <label class="block text-xs font-semibold text-gray-600 uppercase mb-1">Tu Código Exclusivo:</label>
        <div class="flex items-center gap-3">
          <span class="text-2xl font-mono font-bold text-blue-700 tracking-wider">
            {{ overview.referralCode }}
          </span>
          <button
            type="button"
            class="text-xs bg-white border border-gray-300 hover:bg-gray-100 text-gray-700 py-1.5 px-3 rounded font-medium transition"
            @click="copyLink"
          >
            {{ copied ? '¡Enlace copiado!' : 'Copiar enlace de invitación' }}
          </button>
        </div>
      </div>

      <!-- Stats Grid -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="bg-green-50 border border-green-200 rounded p-4">
          <p class="text-xs text-green-700 font-medium">Recompensas consolidadas</p>
          <p class="text-2xl font-bold text-green-900 mt-1">{{ formatCents(overview.totalRewardedCents) }}</p>
          <p class="text-xs text-green-600 mt-1">{{ overview.rewardedCount }} pedidos completados</p>
        </div>

        <div class="bg-yellow-50 border border-yellow-200 rounded p-4">
          <p class="text-xs text-yellow-700 font-medium">En ventana de devolución</p>
          <p class="text-2xl font-bold text-yellow-900 mt-1">{{ formatCents(overview.pendingRewardCents) }}</p>
          <p class="text-xs text-yellow-600 mt-1">{{ overview.pendingWindowCount }} pedidos en periodo de garantía</p>
        </div>

        <div class="bg-gray-50 border border-gray-200 rounded p-4">
          <p class="text-xs text-gray-600 font-medium">Total recomendaciones</p>
          <p class="text-2xl font-bold text-gray-800 mt-1">{{ overview.totalAttributions }}</p>
          <p class="text-xs text-gray-500 mt-1">Registros atribuidos</p>
        </div>
      </div>

      <div class="text-xs text-gray-500 border-t pt-3">
        <p>
          <strong>Ventana de devolución:</strong> Las recompensas quedan retenidas provisionalmente hasta que transcurre
          el plazo legal de devolución (14 días desde la entrega) para evitar fraudes y cancelaciones.
        </p>
      </div>
    </div>
  </div>
</template>
