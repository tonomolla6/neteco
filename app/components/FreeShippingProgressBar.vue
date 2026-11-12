<script setup lang="ts">
import type { FreeShippingProgressEvaluation } from '~~/shared/free-shipping-progress'

/**
 * Portes gratis en una línea y una barra: «Te faltan 143,50 € para el envío gratis». El
 * detalle (palés, mercancías peligrosas, zonas) vive en /envios, a un clic, no en el carrito.
 */
const props = defineProps<{
  evaluation: FreeShippingProgressEvaluation
}>()

const isExcluded = computed(() => props.evaluation.status === 'excluded')
const isInProgress = computed(() => props.evaluation.status === 'in_progress')
const isReached = computed(() => props.evaluation.status === 'reached')
</script>

<template>
  <div v-if="isExcluded || isInProgress || isReached" data-free-shipping class="text-[13px] leading-snug">
    <p v-if="isExcluded" class="text-[var(--text-muted)]">
      {{ evaluation.badgeText }}.
      <NuxtLink to="/envios" class="underline underline-offset-2 hover:text-[var(--link)]">Ver envíos</NuxtLink>
    </p>
    <template v-else>
      <p v-if="isReached" class="font-semibold text-[var(--stock-ok)]">
        <UIcon
          name="i-lucide-circle-check"
          class="mr-0.5 inline size-4 -translate-y-px align-middle"
          aria-hidden="true"
        />
        Tienes el envío gratis
      </p>
      <p v-else class="text-[var(--text)]">
        Te faltan
        <strong class="tabular font-semibold text-[var(--text-strong)]">{{
          formatPrice(evaluation.missingCents)
        }}</strong>
        para el envío gratis
      </p>
      <div
        class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]"
        role="progressbar"
        :aria-valuenow="evaluation.progressPercent"
        :aria-valuemin="0"
        :aria-valuemax="100"
        :aria-label="`Progreso hacia el envío gratis: ${evaluation.progressPercent} %`"
      >
        <div
          class="h-full rounded-full transition-all duration-300"
          :class="isReached ? 'bg-[var(--stock-ok)]' : 'bg-[var(--action)]'"
          :style="{ width: `${evaluation.progressPercent}%` }"
        />
      </div>
    </template>
  </div>
</template>
