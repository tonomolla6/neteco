<script setup lang="ts">
/** Contacto y entrega ya conocidos, resumidos con «Cambiar» en lugar de campos. */
defineProps<{ contact: string; recipient: string; delivery: string; instructions: string }>()
defineEmits<{ change: [] }>()
</script>

<template>
  <div data-checkout-review class="mt-5 space-y-3">
    <div
      class="flex items-start justify-between gap-3 rounded-[var(--radius-surface)] border border-[var(--border)] p-4"
    >
      <div class="min-w-0">
        <p class="text-[13px] font-semibold text-[var(--text-muted)]">Contacto</p>
        <p class="mt-0.5 break-words text-[15px] text-[var(--text-strong)]">{{ contact }}</p>
      </div>
      <button
        type="button"
        data-review-change
        class="min-h-11 shrink-0 font-semibold text-[var(--link)] underline"
        @click="$emit('change')"
      >
        Cambiar
      </button>
    </div>
    <div
      class="flex items-start justify-between gap-3 rounded-[var(--radius-surface)] border border-[var(--border)] p-4"
    >
      <div class="min-w-0">
        <p class="text-[13px] font-semibold text-[var(--text-muted)]">Entrega</p>
        <p class="mt-0.5 break-words text-[15px] text-[var(--text-strong)]">{{ recipient }} · {{ delivery }}</p>
        <p v-if="instructions" class="mt-0.5 text-[13px] text-[var(--text-muted)]">{{ instructions }}</p>
      </div>
      <button
        type="button"
        class="min-h-11 shrink-0 font-semibold text-[var(--link)] underline"
        @click="$emit('change')"
      >
        Cambiar
      </button>
    </div>
  </div>
</template>
