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
  <section aria-labelledby="message-preferences-title" class="space-y-6">
    <UiPageHeader
      id="message-preferences-title"
      title="SMS y WhatsApp"
      description="Aquí ves si nos has dado permiso para avisarte por SMS o WhatsApp, y puedes retirarlo cuando quieras."
    />
    <p v-if="loading && !state" role="status" class="text-sm text-[var(--text-muted)]">Cargando…</p>
    <div
      v-if="error"
      role="alert"
      class="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      <span>{{ error }}</span>
      <button type="button" :disabled="loading" @click="load">Volver a cargar</button>
    </div>
    <p
      v-if="notice"
      role="status"
      class="rounded-[var(--radius-control)] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
    >
      {{ notice }}
    </p>
    <div v-if="state" class="grid gap-4 sm:grid-cols-2">
      <div v-for="channel in ['sms', 'whatsapp'] as const" :key="channel" class="account-card">
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-3">
            <span class="grid size-11 shrink-0 place-items-center rounded-full bg-neteco-50 text-neteco-700">
              <UIcon :name="channel === 'sms' ? 'i-lucide-smartphone' : 'i-lucide-message-circle'" class="size-5" />
            </span>
            <h2>{{ channel === 'sms' ? 'SMS' : 'WhatsApp' }}</h2>
          </div>
          <span
            class="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
            :class="state[channel].granted ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'"
          >
            {{ state[channel].granted ? 'Permitido' : 'No permitido' }}
          </span>
        </div>
        <p class="mt-3 text-sm text-[var(--text-muted)]">
          {{
            state[channel].granted ? 'Podemos enviarte avisos por este canal.' : 'No te enviamos avisos por este canal.'
          }}
        </p>
        <button
          v-if="state[channel].granted"
          type="button"
          class="mt-4"
          :data-channel="channel"
          :disabled="loading"
          @click="revoke(channel)"
        >
          Retirar permiso
        </button>
      </div>
    </div>
    <UiSurface tone="sunken" padding="sm">
      <p class="text-sm text-[var(--text)]">
        Los avisos por correo se gestionan en <NuxtLink to="/cuenta/comunicaciones">Avisos y privacidad</NuxtLink>.
      </p>
    </UiSurface>
  </section>
</template>
