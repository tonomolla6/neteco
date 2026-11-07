<script setup lang="ts">
import CustomerCaseStudiesList from '~/components/CustomerCaseStudiesList.vue'

useSeoMeta({
  title: 'Casos de Éxito de Clientes',
  description:
    'Auditorías técnicas y casos de éxito reales de clientes con evidencia verificada en productos químicos y limpieza profesional.'
})
</script>

<template>
  <main class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <CustomerCaseStudiesList />
  </main>
</template>
