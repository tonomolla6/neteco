<script setup lang="ts">
import AccountB2bRequests from '~/components/AccountB2bRequests.vue'
definePageMeta({ layout: 'cuenta', middleware: 'auth' })
useSeoMeta({ title: 'Solicitudes de empresa', robots: 'noindex, nofollow' })
</script>
<template><AccountB2bRequests /></template>
