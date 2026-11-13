<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Contenido editorial · Admin' })
</script>

<template>
  <AdminPage>
    <AdminEditorialContentEditor />
  </AdminPage>
</template>
