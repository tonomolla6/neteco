<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Revisión de contenidos · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <AdminPage>
    <AdminContentGovernancePanel />
  </AdminPage>
</template>
