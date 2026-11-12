<script setup lang="ts">
// La sección se llama «Listas» en toda la tienda. La dirección antigua sigue funcionando:
// el servidor responde 301 (`routeRules`) y la navegación en cliente redirige aquí.
definePageMeta({ middleware: 'auth', layout: 'cuenta', redirect: '/cuenta/listas' })
</script>

<template>
  <div />
</template>
