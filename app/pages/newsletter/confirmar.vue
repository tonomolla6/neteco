<script setup lang="ts">
import { useNewsletterLinkAction } from '~/composables/useNewsletterLinkAction'

useSeoMeta({ title: 'Confirmar newsletter · NETECO', robots: 'noindex, nofollow' })
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
const { status, message, submit: confirm, canOpenPreferences, openPreferences } = useNewsletterLinkAction('confirm')
</script>

<template>
  <main class="mx-auto max-w-xl px-4 py-20 text-center" :aria-busy="status === 'loading'">
    <UIcon name="i-lucide-mail-check" class="mx-auto size-12 text-neteco-600" />
    <h1 class="mt-4 text-3xl font-bold text-slate-900">Confirma tu suscripción</h1>
    <p class="mt-3 text-slate-600">Solo enviaremos novedades comerciales después de esta confirmación.</p>
    <UButton v-if="status === 'ready'" class="mt-6" size="lg" @click="confirm">Confirmar newsletter</UButton>
    <UButton v-else-if="status === 'loading'" class="mt-6" size="lg" loading disabled role="status"
      >Confirmando</UButton
    >
    <UAlert
      v-else-if="status === 'success'"
      class="mt-6 text-left"
      color="success"
      role="status"
      title="Solicitud procesada"
      description="Si el enlace era válido y no había caducado, tu suscripción ha quedado confirmada. Cada newsletter incluirá una baja directa."
    />
    <template v-else>
      <UAlert
        class="mt-6 text-left"
        color="error"
        role="alert"
        title="No se ha podido confirmar"
        :description="message"
      />
      <UButton v-if="status === 'error'" class="mt-6" size="lg" @click="confirm">Reintentar confirmación</UButton>
    </template>
    <UButton v-if="canOpenPreferences" class="mt-6" variant="outline" @click="openPreferences">
      Elegir temas y frecuencia
    </UButton>
  </main>
</template>
