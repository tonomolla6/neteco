<script setup lang="ts">
import ProductContributionsPanel from './ProductContributionsPanel.vue'
import ProductWatchPanel from './ProductWatchPanel.vue'
const props = withDefaults(
  defineProps<{
    productId?: number
    variantId?: number
    scopeKey: string
    enabled: boolean
    customerEnabled: boolean
  }>(),
  { productId: undefined, variantId: undefined }
)
const watchPending = ref(false),
  contributionPending = ref(false),
  generation = ref(0)
let alive = true
const scope = computed(() =>
  JSON.stringify([props.scopeKey, props.enabled, props.customerEnabled, props.productId, props.variantId])
)
watch(
  scope,
  () => {
    generation.value++
    watchPending.value = false
    contributionPending.value = false
  },
  { flush: 'sync' }
)
const pendingHandlers = computed(() => {
  const captured = scope.value,
    epoch = generation.value
  const current = () => alive && props.enabled && captured === scope.value && epoch === generation.value
  return {
    watch: (value: boolean) => {
      if (current()) watchPending.value = value === true
    },
    contribution: (value: boolean) => {
      if (current()) contributionPending.value = value === true
    }
  }
})
onBeforeUnmount(() => {
  alive = false
  generation.value++
  watchPending.value = false
  contributionPending.value = false
})
</script>
<template>
  <section v-if="enabled" aria-label="Participación y avisos de producto" class="min-w-0 space-y-6">
    <ProductContributionsPanel
      :product-id="productId"
      :scope-key="scope"
      :enabled="enabled"
      :customer-enabled="customerEnabled"
      :pending="watchPending"
      @pending="pendingHandlers.contribution"
    />
    <ProductWatchPanel
      :variant-id="variantId"
      :scope-key="scope"
      :enabled="enabled && customerEnabled"
      :pending="contributionPending"
      @pending="pendingHandlers.watch"
    />
  </section>
</template>
