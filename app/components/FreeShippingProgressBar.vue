<script setup lang="ts">
import type { FreeShippingProgressEvaluation } from '../../shared/free-shipping-progress'

const props = defineProps<{
  evaluation: FreeShippingProgressEvaluation
}>()

const isExcluded = computed(() => props.evaluation.status === 'excluded')
const isInProgress = computed(() => props.evaluation.status === 'in_progress')
const isReached = computed(() => props.evaluation.status === 'reached')
</script>

<template>
  <div
    class="rounded-xl border p-4 transition-all"
    :class="[
      isExcluded
        ? 'border-amber-300 bg-amber-50 text-amber-900'
        : isReached
          ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
          : 'border-slate-200 bg-slate-50 text-slate-800'
    ]"
  >
    <!-- Caso 1: Exclusión (ADR, palé, zona, margen) -->
    <div v-if="isExcluded" class="space-y-1.5">
      <div class="flex items-center gap-2 font-medium">
        <span class="inline-flex size-2 rounded-full bg-amber-500" aria-hidden="true" />
        <span>{{ evaluation.badgeText }}</span>
      </div>
      <p class="text-sm leading-relaxed">
        {{ evaluation.message }}
      </p>
      <p v-if="evaluation.detailedExplanation" class="text-xs text-amber-700/90">
        {{ evaluation.detailedExplanation }}
      </p>
    </div>

    <!-- Caso 2: En progreso o completado -->
    <div v-else-if="isInProgress || isReached" class="space-y-2">
      <div class="flex items-center justify-between text-sm">
        <span class="font-medium">
          {{ evaluation.message }}
        </span>
        <span v-if="isInProgress" class="text-xs font-semibold text-neteco-700">
          {{ evaluation.progressPercent }}%
        </span>
      </div>

      <p v-if="evaluation.detailedExplanation" class="text-xs text-slate-500">
        {{ evaluation.detailedExplanation }}
      </p>

      <!-- Barra de progreso accesible -->
      <div
        class="h-2 w-full overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        :aria-valuenow="evaluation.progressPercent"
        :aria-valuemin="0"
        :aria-valuemax="100"
        :aria-label="`Progreso hacia el umbral de envío gratuito: ${evaluation.progressPercent}%`"
      >
        <div
          class="h-full rounded-full transition-all duration-300"
          :class="isReached ? 'bg-emerald-600' : 'bg-neteco-600'"
          :style="{ width: `${evaluation.progressPercent}%` }"
        />
      </div>

      <!-- La página no conoce el perfil logístico real: el umbral es una referencia, no una promesa. -->
      <p data-free-shipping-qualifier class="text-xs text-slate-500">
        Referencia para paquetería estándar elegible. Sujeto a cotización. Palés y mercancías peligrosas no están
        incluidos.
      </p>
    </div>
  </div>
</template>
