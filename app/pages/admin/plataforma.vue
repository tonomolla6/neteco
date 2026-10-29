<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Plataforma · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-semibold">Portal de plataforma</h1>
      <p class="mt-2">Referencias de servicios, operaciones y plantillas para el equipo.</p>
    </header>
    <AdminDeveloperPortal />
  </div>
</template>
