<script setup lang="ts">
import ProductContributionsPanel from './ProductContributionsPanel.vue'
defineProps<{ scopeKey: string; enabled: boolean; pending?: boolean }>()
const emit = defineEmits<{ pending: [value: boolean] }>()
</script>
<template>
  <ProductContributionsPanel
    :scope-key="scopeKey"
    :enabled="enabled"
    :pending="pending"
    audience="admin"
    @pending="emit('pending', $event)"
  />
</template>
