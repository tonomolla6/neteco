<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Gobierno de contenido · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <div>
    <AdminContentGovernancePanel />
  </div>
</template>
