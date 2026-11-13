<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Oportunidades comerciales · Admin' })
</script>

<template>
  <AdminPage>
    <AdminCommercialPipelinePanel />
  </AdminPage>
</template>
