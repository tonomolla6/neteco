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
  forbidden: 'Tu rol no permite suplantar a clientes.',
  mfa_required: 'Necesitas una sesión con verificación en dos pasos.',
  not_found: 'No hay un ticket abierto de ese cliente con esa referencia.',
  conflict: 'Ya tienes una suplantación abierta. Termínala antes de iniciar otra.',
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
    message.value = 'Suplantación iniciada. Verás el aviso permanente en la parte superior.'
    emit('started', session)
  } catch (cause) {
    const code = (cause as { data?: { error?: { code?: string } } })?.data?.error?.code ?? ''
    message.value = MESSAGES[code] ?? 'No se ha podido iniciar la suplantación.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="space-y-3" aria-labelledby="imp-title" @submit.prevent="start">
    <h2 id="imp-title" class="text-lg font-bold">Actuar como cliente (suplantación de soporte)</h2>
    <p class="text-sm">
      Sesión corta (máximo 15 minutos) ligada a un ticket abierto. Cada acción queda registrada y nunca se permiten
      cambios de credenciales, MFA ni pagos.
    </p>
    <label class="block"
      >ID del cliente
      <input v-model="customerId" data-imp-customer class="block w-full border px-2 py-1" required />
    </label>
    <label class="block"
      >Referencia del ticket
      <input v-model="ticketRef" data-imp-ticket class="block w-full border px-2 py-1" required />
    </label>
    <label class="block"
      >Motivo
      <textarea
        v-model="reason"
        data-imp-reason
        class="block w-full border px-2 py-1"
        minlength="10"
        maxlength="300"
        required
      />
    </label>
    <label class="block"
      >Duración
      <select v-model="minutes" data-imp-minutes class="block border px-2 py-1">
        <option :value="5">5 minutos</option>
        <option :value="10">10 minutos</option>
        <option :value="15">15 minutos</option>
      </select>
    </label>
    <p v-if="message" data-imp-message role="status">{{ message }}</p>
    <button data-imp-start type="submit" class="rounded border px-4 py-2" :disabled="busy">Iniciar suplantación</button>
  </form>
</template>
