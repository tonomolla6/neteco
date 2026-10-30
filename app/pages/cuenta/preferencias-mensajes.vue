<script setup lang="ts">
import HighValueOptOut from '../../components/HighValueOptOut.vue'
definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Preferencias de mensajes', robots: 'noindex, nofollow' })
</script>
<template><HighValueOptOut /></template>
