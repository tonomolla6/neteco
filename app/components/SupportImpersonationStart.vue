<script setup lang="ts">
import { impersonationSessionSchema, type ImpersonationSession } from '~~/shared/support-impersonation'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'

const props = defineProps<{ customerId?: string; ticketRef?: string }>()
const emit = defineEmits<{ started: [ImpersonationSession] }>()
const request = useRequestFetch()
const customerId = ref(props.customerId ?? ''),
  ticketRef = ref(props.ticketRef ?? ''),
  reason = ref(''),
  minutes = ref(10),
  busy = ref(false),
  message = ref('')
const MESSAGES: Record<string, string> = {
  forbidden: 'Tu perfil no tiene permiso para ver la tienda como un cliente.',
  mfa_required: 'Necesitas una sesión con verificación en dos pasos.',
  not_found: 'No hay una consulta abierta de ese cliente con esa referencia.',
  conflict: 'Ya estás viendo la tienda como otro cliente. Termina esa sesión antes de empezar otra.',
  invalid_input:
    'Revisa los datos: el motivo debe tener entre 10 y 300 caracteres y la duración máxima es de 15 minutos.'
}
async function start() {
  if (busy.value) return
  busy.value = true
  message.value = ''
  try {
    const session = impersonationSessionSchema.parse(
      catalogPolicyOwnJson(
        await request<unknown>('/api/admin/support-impersonation', {
          method: 'POST',
          body: {
            customerId: customerId.value.trim(),
            ticketRef: ticketRef.value.trim(),
            reason: reason.value.trim(),
            minutes: Number(minutes.value)
          },
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomId() },
          retry: 0
        })
      )
    )
    reason.value = ''
    message.value = 'Ya estás viendo la tienda como el cliente. Verás un aviso permanente en la parte superior.'
    emit('started', session)
  } catch (cause) {
    const code = (cause as { data?: { error?: { code?: string } } })?.data?.error?.code ?? ''
    message.value = MESSAGES[code] ?? 'No se ha podido empezar la sesión. Vuelve a intentarlo.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="adm-stack max-w-2xl" aria-labelledby="imp-title" @submit.prevent="start">
    <AdminCard
      description="Sesión corta (máximo 15 minutos) ligada a una consulta abierta. Todo lo que hagas queda registrado y no se pueden cambiar contraseñas, la verificación en dos pasos ni los pagos."
    >
      <template #title><span id="imp-title">Ver la tienda como el cliente</span></template>
      <div class="adm-stack">
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Identificador del cliente" help="Lo encuentras en su ficha." required>
            <input :id="id" v-model="customerId" data-imp-customer class="adm-input" required />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Referencia de la consulta" required>
            <input :id="id" v-model="ticketRef" data-imp-ticket class="adm-input" required />
          </AdminFormField>
        </div>
        <AdminFormField v-slot="{ id }" label="Motivo" help="Entre 10 y 300 caracteres. Queda en el registro." required>
          <textarea
            :id="id"
            v-model="reason"
            data-imp-reason
            class="adm-input"
            rows="3"
            minlength="10"
            maxlength="300"
            required
          />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Duración">
          <select :id="id" v-model="minutes" data-imp-minutes class="adm-input w-auto">
            <option :value="5">5 minutos</option>
            <option :value="10">10 minutos</option>
            <option :value="15">15 minutos</option>
          </select>
        </AdminFormField>
        <UAlert
          v-if="message"
          data-imp-message
          role="status"
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          :title="message"
        />
      </div>
      <template #footer>
        <button data-imp-start type="submit" class="adm-btn adm-btn--primary" :disabled="busy">
          Ver como este cliente
        </button>
      </template>
    </AdminCard>
  </form>
</template>
