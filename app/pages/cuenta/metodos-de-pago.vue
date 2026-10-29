<script setup lang="ts">
import PaymentTokenRemoval from '~/components/PaymentTokenRemoval.vue'
definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Métodos de pago', robots: 'noindex, nofollow' })
</script>
<template><PaymentTokenRemoval /></template>
