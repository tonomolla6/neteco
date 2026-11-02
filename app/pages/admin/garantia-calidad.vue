<script setup lang="ts">
import AdminQualityAssuranceSuite from '~/components/AdminQualityAssuranceSuite.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Garantía de calidad y tests · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div>
    <AdminQualityAssuranceSuite />
  </div>
</template>
