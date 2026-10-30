<script setup lang="ts">
import AdminModelEvaluationGate from '../../components/AdminModelEvaluationGate.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({
  title: 'Evaluación de Modelos e IA Quality Gate · Admin',
  robots: 'noindex, nofollow, noarchive'
})
</script>

<template>
  <AdminModelEvaluationGate />
</template>
