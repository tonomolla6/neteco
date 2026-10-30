<script setup lang="ts">
import QuickOrderPanel from '~/components/QuickOrderPanel.vue'
import B2BQuickOrderImport from '~/components/B2BQuickOrderImport.vue'
useSeoMeta({ title: 'Pedido rápido por SKU / EAN', robots: 'noindex, nofollow' })
</script>

<template>
  <div>
    <QuickOrderPanel />
    <B2BQuickOrderImport />
  </div>
</template>
