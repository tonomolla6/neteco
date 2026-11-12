<script setup lang="ts">
defineProps<{ locked: boolean; applied: boolean; feedback: string; isError: boolean }>()
defineEmits<{ apply: []; remove: [] }>()
const draft = defineModel<string>({ required: true })
</script>

<template>
  <section class="mt-4 border-t border-slate-100 pt-4" aria-labelledby="checkout-coupon-label">
    <label id="checkout-coupon-label" for="checkout-coupon-code" class="block text-sm font-medium text-slate-700"
      >Código de descuento</label
    >
    <input
      id="checkout-coupon-code"
      v-model="draft"
      data-testid="checkout-coupon-code"
      type="text"
      maxlength="64"
      autocomplete="off"
      :disabled="locked"
      class="mt-2 w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
      @keydown.enter.prevent="$emit('apply')"
    />
    <div class="mt-2 flex flex-wrap gap-2">
      <UButton
        type="button"
        data-testid="checkout-coupon-apply"
        :disabled="locked || !draft.trim()"
        @click="$emit('apply')"
        >Aplicar</UButton
      >
      <UButton
        type="button"
        data-testid="checkout-coupon-remove"
        variant="outline"
        :disabled="locked || (!applied && !draft.trim())"
        @click="$emit('remove')"
        >Quitar</UButton
      >
    </div>
    <p
      v-if="feedback"
      data-testid="checkout-coupon-feedback"
      :role="isError ? 'alert' : 'status'"
      class="mt-2 text-sm text-slate-700"
    >
      {{ feedback }}
    </p>
  </section>
</template>
