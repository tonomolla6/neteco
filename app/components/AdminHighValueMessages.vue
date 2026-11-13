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
  <section aria-label="Avisos importantes por SMS y WhatsApp" class="adm-stack">
    <AdminCard
      title="Buscar cliente"
      description="Consulta si un cliente acepta avisos importantes por SMS o WhatsApp antes de registrar cambios o hacer pruebas."
    >
      <form data-test="load" class="flex flex-wrap items-end gap-3" @submit.prevent="load">
        <div class="adm-field min-w-0 flex-1 sm:max-w-md">
          <label for="messages-customer" class="adm-label">Identificador de cliente</label>
          <input
            id="messages-customer"
            v-model="customer"
            name="customer"
            placeholder="Pega el identificador de la ficha del cliente"
            :disabled="loading"
          />
        </div>
        <button class="adm-btn adm-btn--primary" :disabled="loading">Consultar</button>
      </form>
    </AdminCard>

    <p v-if="loading" role="status" class="adm-help">Cargando…</p>
    <UAlert v-if="error" role="alert" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />

    <template v-if="consent && target === customer.trim()">
      <AdminCard
        title="Consentimiento del cliente"
        description="Cada cambio queda registrado junto a la referencia que lo justifica."
      >
        <div class="adm-stack">
          <div class="adm-field sm:max-w-md">
            <label for="messages-proof" class="adm-label">Referencia de evidencia</label>
            <input id="messages-proof" v-model="proof" name="proof" autocomplete="off" />
            <p class="adm-help">Por ejemplo, el número de la consulta o del formulario donde el cliente lo pidió.</p>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <section
              v-for="channel in ['sms', 'whatsapp'] as const"
              :key="channel"
              class="rounded-[var(--radius-surface)] border border-[var(--border)] p-4"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h2>{{ channel === 'sms' ? 'SMS' : 'WhatsApp' }}</h2>
                <AdminBadge :tone="consent[channel].granted ? 'success' : 'neutral'">
                  {{ consent[channel].granted ? 'Consentimiento activo' : 'Sin consentimiento activo' }}
                </AdminBadge>
              </div>
              <div class="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  :data-action="`grant-${channel}`"
                  :disabled="loading"
                  @click="changeConsent(channel, 'grant')"
                >
                  Registrar consentimiento
                </button>
                <button
                  type="button"
                  class="adm-btn adm-btn--danger-soft adm-btn--sm"
                  :data-action="`revoke-${channel}`"
                  :disabled="loading"
                  @click="changeConsent(channel, 'revoke')"
                >
                  Registrar baja
                </button>
              </div>
            </section>
          </div>
        </div>
      </AdminCard>

      <AdminCard title="Aviso de prueba" description="Simula un aviso para comprobar qué recibiría este cliente.">
        <div class="adm-form-grid">
          <div class="adm-field">
            <label for="messages-event-id" class="adm-label">Identificador del evento</label>
            <input id="messages-event-id" v-model="eventId" name="eventId" autocomplete="off" />
          </div>
          <div class="adm-field">
            <label for="messages-event" class="adm-label">Tipo de aviso</label>
            <select id="messages-event" v-model="event">
              <option value="recall">Retirada de producto</option>
              <option value="delivery_exception">Incidencia de entrega</option>
              <option value="security_alert">Aviso de seguridad</option>
            </select>
          </div>
        </div>
        <template #footer>
          <button
            type="button"
            class="adm-btn adm-btn--secondary"
            data-action="simulate-sms"
            :disabled="loading"
            @click="sendSms"
          >
            Simular SMS
          </button>
          <button
            v-if="wa"
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="loading || wa.handoff"
            @click="sendWa"
          >
            Simular WhatsApp
          </button>
        </template>
      </AdminCard>

      <AdminCard v-if="wa" title="Simulación de WhatsApp">
        <template #actions>
          <AdminBadge :tone="wa.handoff ? 'warning' : 'success'">
            {{ wa.handoff ? 'Atención humana' : 'Automatización disponible' }}
          </AdminBadge>
        </template>
        <div class="adm-stack">
          <div class="adm-form-grid">
            <div class="adm-field">
              <label for="messages-template" class="adm-label">Identificador de plantilla</label>
              <input id="messages-template" v-model="templateId" />
            </div>
            <div class="adm-field">
              <label for="messages-approval" class="adm-label">Referencia de aprobación</label>
              <input id="messages-approval" v-model="approvalRef" />
            </div>
          </div>
          <p v-if="wa.templates.length" class="adm-help">
            {{ wa.templates.length }}
            {{ wa.templates.length === 1 ? 'plantilla registrada' : 'plantillas registradas' }} para este cliente.
          </p>
        </div>
        <template #footer>
          <button
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="loading"
            @click="changeWa('approve_template')"
          >
            Registrar plantilla simulada
          </button>
          <button
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="loading"
            @click="changeWa('inbound')"
          >
            Simular mensaje entrante
          </button>
          <button
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="loading"
            @click="changeWa('handoff')"
          >
            Solicitar atención humana
          </button>
          <button
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="loading"
            @click="changeWa('resume')"
          >
            Reanudar simulación
          </button>
        </template>
      </AdminCard>
      <UAlert
        v-else
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        title="La simulación de WhatsApp no está disponible."
      />
    </template>
  </section>
</template>
