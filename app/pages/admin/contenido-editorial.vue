<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Contenido Editorial Profesional · Admin' })
</script>

<template>
  <div class="p-6">
    <AdminEditorialContentEditor />
  </div>
</template>
