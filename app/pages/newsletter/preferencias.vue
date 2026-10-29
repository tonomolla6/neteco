<script setup lang="ts">
import NewsletterPreferencesPanel from '../../components/NewsletterPreferencesPanel.vue'
import { newsletterPreferenceAccessSchema } from '~~/shared/newsletter-editorial'
useSeoMeta({ title: 'Preferencias newsletter', robots: 'noindex, nofollow, noarchive' })
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
const token = ref(''),
  loaded = ref(false),
  confirmation = ref(''),
  busy = ref(false),
  error = ref('')
const fetch = useRequestFetch()
let epoch = 0
const authorize = () => loaded.value && /^np1\.[a-f0-9-]{36}\.[1-9]\d{9}\.[a-f0-9]{64}$/.test(token.value)
onMounted(() => {
  const url = new URL(window.location.href),
    values = url.searchParams.getAll('token'),
    proof = url.searchParams.getAll('confirm')
  if (values.length === 1) token.value = values[0] ?? ''
  if (values.length === 0 && proof.length === 1 && /^n1\.[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(proof[0] ?? ''))
    confirmation.value = proof[0] ?? ''
  url.searchParams.delete('token')
  url.searchParams.delete('confirm')
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  loaded.value = true
})
onBeforeUnmount(() => {
  epoch++
  token.value = ''
  confirmation.value = ''
})
async function access() {
  if (busy.value || !confirmation.value || !loaded.value) return
  const turn = ++epoch
  busy.value = true
  error.value = ''
  try {
    const value = newsletterPreferenceAccessSchema.parse(
      await fetch<unknown>('/api/newsletter/preferences/access', {
        method: 'POST',
        body: { confirmationToken: confirmation.value }
      })
    )
    if (turn !== epoch) return
    token.value = value.token
    confirmation.value = ''
  } catch {
    if (turn === epoch)
      error.value =
        'No hay acceso confirmado: primero confirma el doble opt-in y usa un enlace vigente. No se ha creado ni reactivado consentimiento.'
  } finally {
    if (turn === epoch) busy.value = false
  }
}
</script>
<template>
  <main class="mx-auto max-w-3xl space-y-6 px-4 py-10">
    <h1 class="text-2xl font-bold">Preferencias newsletter</h1>
    <NewsletterPreferencesPanel
      v-if="authorize()"
      endpoint="/api/newsletter/preferences"
      :bearer="token"
      actor-id="newsletter-bearer-session"
      :authorize="authorize"
    />
    <div v-else-if="confirmation" class="space-y-3">
      <p>
        Tu enlace de confirmación permite obtener acceso a las preferencias sólo después de confirmar el doble opt-in y
        mientras siga vigente. No elige temas ni frecuencia por ti.
      </p>
      <button type="button" :disabled="busy" @click="access">Obtener acceso a mis preferencias</button>
      <p v-if="error" role="alert">{{ error }}</p>
    </div>
    <p v-else>
      Abre un enlace reciente recibido en tu newsletter. No publicamos el token ni datos de otros destinatarios.
    </p>
  </main>
</template>
