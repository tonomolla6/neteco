<script setup lang="ts">
import ReferralAccountPanel from '../../components/marketing/ReferralAccountPanel.vue'

definePageMeta({
  middleware: 'auth',
  layout: 'cuenta'
})

useSeoMeta({
  title: 'Programa de referidos · Mi cuenta',
  robots: 'noindex, nofollow'
})
</script>

<template>
  <div class="cuenta-referidos space-y-6">
    <UiPageHeader
      title="Programa de referidos"
      description="Invita a otras empresas del sector a comprar en NETECO y recibe saldo para tus próximos pedidos."
    />
    <div class="account-embedded">
      <ReferralAccountPanel />
    </div>
  </div>
</template>
