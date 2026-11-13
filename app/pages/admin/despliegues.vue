<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Publicación de versiones · Admin' })
</script>

<template>
  <AdminPage>
    <AdminReleaseGatesPanel />
  </AdminPage>
</template>
