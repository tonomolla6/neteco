<script setup lang="ts">
import ReferralAccountPanel from '../../components/marketing/ReferralAccountPanel.vue'

definePageMeta({
  middleware: 'auth'
})

useSeoMeta({
  title: 'Programa de referidos · Mi cuenta',
  robots: 'noindex, nofollow'
})
</script>

<template>
  <div class="cuenta-referidos max-w-4xl mx-auto px-4 py-8 space-y-6">
    <div class="border-b pb-4">
      <h1 class="text-2xl font-bold text-gray-900">Programa de Referidos Profesional</h1>
      <p class="text-sm text-gray-600 mt-1">
        Invita a empresas del sector a abastecerse en Neteco y recibe comisiones comerciales en saldo aplicable a tus
        futuros pedidos.
      </p>
    </div>

    <ReferralAccountPanel />
  </div>
</template>
