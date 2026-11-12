<script setup lang="ts">
import type { CheckoutContact } from './CheckoutContactFields.vue'

/** Primero la pregunta; los datos fiscales solo si hacen falta, y entonces son obligatorios. */
defineProps<{ errors: Record<string, string> }>()
const invoice = defineModel<'ticket' | 'company'>({ required: true })
const contact = defineModel<CheckoutContact>('contact', { required: true })
</script>

<template>
  <div>
    <fieldset data-invoice-choice class="mt-5">
      <legend class="text-[15px] font-semibold text-[var(--text-strong)]">¿Qué documento necesitas?</legend>
      <div class="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-[15px] text-[var(--text)]">
        <label class="flex min-h-11 items-center gap-2">
          <input v-model="invoice" type="radio" name="invoice" value="ticket" class="accent-neteco-600" />
          Ticket a mi nombre
        </label>
        <label class="flex min-h-11 items-center gap-2">
          <input v-model="invoice" type="radio" name="invoice" value="company" class="accent-neteco-600" />
          Factura de empresa
        </label>
      </div>
    </fieldset>
    <div v-if="invoice === 'company'" data-invoice-fields class="mt-3 grid gap-4 grid-cols-1 sm:grid-cols-2">
      <UFormField label="Razón social" required :error="errors.company">
        <UInput v-model="contact.company" class="w-full" autocomplete="organization" />
      </UFormField>
      <UFormField label="NIF o CIF" required :error="errors.nif">
        <UInput v-model="contact.nif" class="w-full" autocapitalize="characters" />
      </UFormField>
    </div>
  </div>
</template>
