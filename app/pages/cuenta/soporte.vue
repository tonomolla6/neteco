<script setup lang="ts">
import CustomerSupportSection from '~/components/CustomerSupportSection.vue'
definePageMeta({ layout: 'cuenta', middleware: 'auth' })
useSeoMeta({ title: 'Mis consultas de soporte', robots: 'noindex, nofollow' })
const runtime = useRuntimeConfig()
</script>
<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Mis consultas"
      description="El seguimiento de lo que nos has preguntado y nuestras respuestas."
    >
      <template #actions>
        <UButton to="/contacto" icon="i-lucide-plus">Nueva consulta</UButton>
      </template>
    </UiPageHeader>
    <div v-if="runtime.public.serverRuntime === 'cloudflare'" class="account-card account-embedded">
      <CustomerSupportSection :runtime="runtime.public.serverRuntime" />
    </div>
    <UiSurface v-else padding="none">
      <UiEmptyState
        icon="i-lucide-life-buoy"
        title="Todavía no puedes seguir tus consultas desde aquí"
        description="Escríbenos y te respondemos por correo."
      >
        <UButton to="/contacto">Escribir una consulta</UButton>
      </UiEmptyState>
    </UiSurface>
  </div>
</template>
