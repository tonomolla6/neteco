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
    <p>Desde aquí todavía no puedes seguir tus consultas. Escríbenos y te respondemos por correo.</p>
    <NuxtLink to="/contacto">Escribir una consulta</NuxtLink>
  </section>
</template>
