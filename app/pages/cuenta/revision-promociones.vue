<script setup lang="ts">
import AccountPromoFraudAppeals from '../../components/AccountPromoFraudAppeals.vue'
definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Revisión de promociones', robots: 'noindex, nofollow' })
</script>

<template><AccountPromoFraudAppeals /></template>
