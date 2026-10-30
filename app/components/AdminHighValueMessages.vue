<script setup lang="ts">
import { ref } from 'vue'
const request = useRequestFetch()
type Channel = 'sms' | 'whatsapp'
type Consent = { version: number; granted: boolean }
type WaState = {
  version: number
  handoff: boolean
  lastInboundAt: string | null
  templates: Array<{ event: string; templateId: string }>
}
const customer = ref(''),
  target = ref(''),
  proof = ref(''),
  eventId = ref(''),
  event = ref<'recall' | 'delivery_exception' | 'security_alert'>('recall'),
  templateId = ref(''),
  approvalRef = ref('')
const consent = ref<Record<Channel, Consent> | null>(null),
  wa = ref<WaState | null>(null),
  loading = ref(false),
  error = ref(''),
  notice = ref('')
let pending: { signature: string; key: string } | null = null
async function load() {
  const id = customer.value.trim()
  error.value = ''
  notice.value = ''
  consent.value = null
  wa.value = null
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    error.value = 'Indique un identificador de cliente válido.'
    return
  }
  loading.value = true
  try {
    const [sms, whatsapp] = await Promise.all([
      request<Consent>(`/api/admin/customers/${id}/high-value-consent/sms`),
      request<Consent>(`/api/admin/customers/${id}/high-value-consent/whatsapp`)
    ])
    if (customer.value.trim() !== id) return
    target.value = id
    consent.value = { sms, whatsapp }
    try {
      wa.value = await request<WaState>(`/api/admin/customers/${id}/whatsapp-business/status`)
    } catch {
      wa.value = null
    }
  } catch {
    error.value = 'No se han podido cargar las preferencias del cliente.'
  } finally {
    loading.value = false
  }
}
async function post(path: string, body: Record<string, unknown>) {
  if (!consent.value || loading.value || target.value !== customer.value.trim()) return null
  const signature = JSON.stringify([target.value, path, body])
  if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() }
  loading.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await request<Record<string, unknown>>(`/api/admin/customers/${target.value}/${path}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': pending.key },
      body
    })
    pending = null
    return result
  } catch {
    error.value = 'No se ha podido confirmar la operación. Reintente o vuelva a cargar.'
    return null
  } finally {
    loading.value = false
  }
}
async function changeConsent(channel: Channel, action: 'grant' | 'revoke') {
  if (!consent.value) return
  const result = await post(`high-value-consent/${channel}`, {
    action,
    expectedVersion: consent.value[channel].version,
    proof: proof.value
  })
  if (result && typeof result.version === 'number' && consent.value) {
    consent.value[channel] = { version: result.version, granted: action === 'grant' }
    notice.value = 'Preferencia registrada.'
  }
}
async function sendSms() {
  if (!consent.value) return
  const result = await post('high-value-messages', {
    eventId: eventId.value,
    event: event.value,
    channel: 'sms',
    consentVersion: consent.value.sms.version
  })
  if (result)
    notice.value = result.status === 'fallback' ? 'Se requiere gestión manual.' : 'Simulación de SMS registrada.'
}
async function changeWa(action: 'approve_template' | 'inbound' | 'handoff' | 'resume') {
  if (!wa.value) return
  const body =
    action === 'approve_template'
      ? {
          action,
          expectedVersion: wa.value.version,
          event: event.value,
          templateId: templateId.value,
          approvalRef: approvalRef.value
        }
      : { action, expectedVersion: wa.value.version }
  const result = await post('whatsapp-business/state', body)
  if (result && typeof result.version === 'number' && wa.value) {
    wa.value.version = result.version
    if (action === 'handoff') wa.value.handoff = true
    if (action === 'resume') wa.value.handoff = false
    notice.value = 'Estado de simulación registrado.'
  }
}
async function sendWa() {
  if (!wa.value || !consent.value) return
  const result = await post('whatsapp-business/messages', {
    eventId: eventId.value,
    event: event.value,
    consentVersion: consent.value.whatsapp.version,
    stateVersion: wa.value.version
  })
  if (result) notice.value = 'Simulación de WhatsApp registrada.'
}
</script>
<template>
  <section aria-labelledby="messages-title">
    <h1 id="messages-title">Avisos de alto valor</h1>
    <p>Las operaciones de envío disponibles aquí son simulaciones; no envían mensajes externos.</p>
    <form data-test="load" @submit.prevent="load">
      <label for="messages-customer">Identificador de cliente</label
      ><input id="messages-customer" v-model="customer" name="customer" :disabled="loading" /><button
        :disabled="loading"
      >
        Consultar
      </button>
    </form>
    <p v-if="loading" role="status">Cargando…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="consent && target === customer.trim()">
      <label for="messages-proof">Referencia de evidencia</label
      ><input id="messages-proof" v-model="proof" name="proof" autocomplete="off" />
      <section v-for="channel in ['sms', 'whatsapp'] as const" :key="channel">
        <h2>{{ channel === 'sms' ? 'SMS' : 'WhatsApp' }}</h2>
        <p>
          {{ consent[channel].granted ? 'Consentimiento activo' : 'Sin consentimiento activo' }} · versión
          {{ consent[channel].version }}
        </p>
        <button
          type="button"
          :data-action="`grant-${channel}`"
          :disabled="loading"
          @click="changeConsent(channel, 'grant')"
        >
          Registrar consentimiento</button
        ><button
          type="button"
          :data-action="`revoke-${channel}`"
          :disabled="loading"
          @click="changeConsent(channel, 'revoke')"
        >
          Registrar baja
        </button>
      </section>
      <label for="messages-event-id">Identificador del evento</label
      ><input id="messages-event-id" v-model="eventId" name="eventId" autocomplete="off" />
      <label for="messages-event">Evento</label
      ><select id="messages-event" v-model="event">
        <option value="recall">Retirada de producto</option>
        <option value="delivery_exception">Incidencia de entrega</option>
        <option value="security_alert">Aviso de seguridad</option>
      </select>
      <button type="button" data-action="simulate-sms" :disabled="loading" @click="sendSms">Simular SMS</button>
      <div v-if="wa">
        <h2>Simulación de WhatsApp</h2>
        <p>Versión {{ wa.version }} · {{ wa.handoff ? 'Atención humana' : 'Automatización disponible' }}</p>
        <label for="messages-template">Identificador de plantilla</label
        ><input id="messages-template" v-model="templateId" /><label for="messages-approval"
          >Referencia de aprobación</label
        ><input id="messages-approval" v-model="approvalRef" /><button
          type="button"
          :disabled="loading"
          @click="changeWa('approve_template')"
        >
          Registrar plantilla simulada</button
        ><button type="button" :disabled="loading" @click="changeWa('inbound')">Simular mensaje entrante</button
        ><button type="button" :disabled="loading" @click="changeWa('handoff')">Solicitar atención humana</button
        ><button type="button" :disabled="loading" @click="changeWa('resume')">Reanudar simulación</button
        ><button type="button" :disabled="loading || wa.handoff" @click="sendWa">Simular WhatsApp</button>
      </div>
      <p v-else>La simulación de WhatsApp no está disponible.</p>
    </div>
  </section>
</template>
