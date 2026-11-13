<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Planificación de contenidos · Admin' })
</script>

<template>
  <AdminPage>
    <AdminEditorialSeoBriefingPanel />
  </AdminPage>
</template>
