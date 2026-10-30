<script setup lang="ts">
import { onMounted, ref } from 'vue'
const request = useRequestFetch()
type Channel = 'sms' | 'whatsapp'
type Consent = { version: number; granted: boolean }
const state = ref<Record<Channel, Consent> | null>(null)
const loading = ref(true),
  error = ref(''),
  notice = ref('')
const retries = new Map<Channel, { version: number; key: string }>()
async function load() {
  loading.value = true
  error.value = ''
  state.value = null
  try {
    const [sms, whatsapp] = await Promise.all([
      request<Consent>('/api/account/high-value-consent/sms'),
      request<Consent>('/api/account/high-value-consent/whatsapp')
    ])
    state.value = { sms, whatsapp }
  } catch {
    error.value = 'No se han podido cargar las preferencias.'
  } finally {
    loading.value = false
  }
}
async function revoke(channel: Channel) {
  const current = state.value?.[channel]
  if (!current || loading.value) return
  if (retries.get(channel)?.version !== current.version)
    retries.set(channel, { version: current.version, key: crypto.randomUUID() })
  loading.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await request<{ version: number }>(`/api/account/high-value-consent/${channel}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': retries.get(channel)!.key },
      body: { expectedVersion: current.version }
    })
    if (state.value) state.value[channel] = { version: result.version, granted: false }
    retries.delete(channel)
    notice.value = 'Preferencia actualizada.'
  } catch {
    error.value = 'No se ha podido confirmar la baja. Puede reintentar o volver a cargar.'
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>
<template>
  <section aria-labelledby="message-preferences-title">
    <h1 id="message-preferences-title">Preferencias de mensajes</h1>
    <p>Puede retirar su consentimiento para recibir avisos por estos canales.</p>
    <p v-if="loading" role="status">Cargando…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="state">
      <div v-for="channel in ['sms', 'whatsapp'] as const" :key="channel">
        <h2>{{ channel === 'sms' ? 'SMS' : 'WhatsApp' }}</h2>
        <p>{{ state[channel].granted ? 'Consentimiento activo' : 'Sin consentimiento activo' }}</p>
        <button
          v-if="state[channel].granted"
          type="button"
          :data-channel="channel"
          :disabled="loading"
          @click="revoke(channel)"
        >
          Retirar consentimiento
        </button>
      </div>
    </div>
    <button v-if="error" type="button" :disabled="loading" @click="load">Volver a cargar</button>
  </section>
</template>
