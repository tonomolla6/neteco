<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Release Gates y Despliegues · Admin' })
</script>

<template>
  <main class="admin-page-container">
    <AdminReleaseGatesPanel />
  </main>
</template>

<style scoped>
.admin-page-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem;
}
</style>
