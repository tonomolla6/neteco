<script setup lang="ts">
/**
 * Un paso del pago. Para el invitado funciona como acordeón: un paso abierto cada vez y
 * los completados plegados en una línea con «Cambiar». Para quien tiene cuenta todos los
 * pasos están abiertos y no hay botón de continuar. El contenido se oculta, no se
 * desmonta: los campos se validan y se envían igual.
 */
defineProps<{
  step: string
  number: number
  title: string
  anchor?: string
  open: boolean
  done: boolean
  current: boolean
  continueLabel?: string
}>()
defineEmits<{ continue: []; change: [] }>()
</script>

<template>
  <section
    :id="anchor"
    :data-checkout-step="step"
    :aria-current="current ? 'step' : undefined"
    class="scroll-mt-40 rounded-2xl border border-slate-200 bg-white p-6"
  >
    <div class="flex items-center justify-between gap-3">
      <h2 class="flex items-center gap-2 text-lg font-bold text-slate-900">
        <span class="flex size-7 items-center justify-center rounded-full bg-neteco-600 text-sm font-bold text-white">{{
          number
        }}</span>
        {{ title }}
      </h2>
      <button
        v-if="done"
        type="button"
        data-step-change
        class="min-h-11 shrink-0 font-semibold text-[var(--link)] underline"
        @click="$emit('change')"
      >
        Cambiar
      </button>
    </div>
    <div v-if="done" data-step-summary class="mt-2 break-words text-[15px] text-[var(--text)]">
      <slot name="summary" />
    </div>
    <div v-show="open" data-step-body>
      <slot />
      <UButton v-if="continueLabel" type="button" size="lg" class="mt-6" data-step-continue @click="$emit('continue')">
        {{ continueLabel }}
      </UButton>
    </div>
  </section>
</template>
