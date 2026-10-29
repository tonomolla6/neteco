<script setup lang="ts">
import CustomerSupportSection from '~/components/CustomerSupportSection.vue'
definePageMeta({ layout: 'cuenta', middleware: 'auth' })
useSeoMeta({ title: 'Mis consultas de soporte', robots: 'noindex, nofollow' })
const runtime = useRuntimeConfig()
</script>
<template>
  <CustomerSupportSection
    v-if="runtime.public.serverRuntime === 'cloudflare'"
    :runtime="runtime.public.serverRuntime"
  />
  <section v-else>
    <h1>Soporte de mi cuenta</h1>
    <p>El portal privado nativo está disponible en el adaptador Cloudflare.</p>
    <NuxtLink to="/contacto">Registrar consulta</NuxtLink>
  </section>
</template>
