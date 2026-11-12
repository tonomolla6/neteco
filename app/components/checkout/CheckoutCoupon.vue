<script setup lang="ts">
/**
 * Código de descuento, fuera de la vista hasta que se pide: un enlace en el resumen abre un
 * modal con el campo. Quien no tiene código no ve un formulario vacío que le haga dudar.
 */
const props = defineProps<{ locked: boolean; applied: boolean; feedback: string; isError: boolean }>()
const emit = defineEmits<{ apply: []; remove: [] }>()
const draft = defineModel<string>({ required: true })
const open = ref(false)

function apply() {
  emit('apply')
}
function remove() {
  emit('remove')
}
// Aplicado: el modal ha cumplido y se cierra solo; el resultado queda en el resumen.
watch(
  () => props.feedback,
  (feedback) => {
    if (props.applied && !props.isError && feedback.startsWith('Cupón aplicado')) open.value = false
  }
)
</script>

<template>
  <section class="mt-3" aria-label="Código de descuento" data-checkout-coupon>
    <div class="flex flex-wrap items-center justify-between gap-2 text-[13px]">
      <button
        type="button"
        data-testid="checkout-coupon-open"
        class="inline-flex min-h-9 items-center gap-1.5 font-semibold text-[var(--link)] underline underline-offset-2"
        @click="open = true"
      >
        <UIcon name="i-lucide-ticket-percent" class="size-4" aria-hidden="true" />
        {{ applied ? `Código ${draft.trim().toUpperCase()}` : '¿Tienes un código de descuento?' }}
      </button>
      <button
        v-if="applied"
        type="button"
        class="min-h-9 text-[var(--text-muted)] underline underline-offset-2"
        :disabled="locked"
        @click="remove"
      >
        Quitar
      </button>
    </div>
    <p
      v-if="feedback && !open"
      data-testid="checkout-coupon-feedback"
      :role="isError ? 'alert' : 'status'"
      class="mt-1 text-[13px]"
      :class="isError ? 'text-[var(--ui-error)]' : 'text-[var(--text)]'"
    >
      {{ feedback }}
    </p>

    <UModal v-model:open="open" title="Código de descuento" :ui="{ content: 'sm:max-w-md' }">
      <template #body>
        <label for="checkout-coupon-code" class="block text-[15px] font-medium text-[var(--text-strong)]">
          Escribe tu código
        </label>
        <input
          id="checkout-coupon-code"
          v-model="draft"
          data-testid="checkout-coupon-code"
          type="text"
          maxlength="64"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          :disabled="locked"
          class="mt-2 h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[15px] uppercase disabled:opacity-60"
          @keydown.enter.prevent="apply"
        />
        <p
          v-if="feedback"
          data-testid="checkout-coupon-feedback"
          :role="isError ? 'alert' : 'status'"
          class="mt-2 text-[13px]"
          :class="isError ? 'text-[var(--ui-error)]' : 'text-[var(--text)]'"
        >
          {{ feedback }}
        </p>
        <p v-else class="mt-2 text-[13px] text-[var(--text-muted)]">
          El descuento se aplica al total antes de pagar. Un código por pedido.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            type="button"
            data-testid="checkout-coupon-remove"
            color="neutral"
            variant="ghost"
            :disabled="locked || (!applied && !draft.trim())"
            @click="remove"
          >
            Quitar
          </UButton>
          <UButton type="button" data-testid="checkout-coupon-apply" :disabled="locked || !draft.trim()" @click="apply">
            Aplicar código
          </UButton>
        </div>
      </template>
    </UModal>
  </section>
</template>
