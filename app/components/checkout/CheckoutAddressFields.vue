<script setup lang="ts">
import type { CheckoutAddress } from './CheckoutBillingAddress.vue'

defineProps<{ errors: Record<string, string> }>()
// El objeto es del formulario de la página: los campos se editan en su sitio.
const address = defineModel<CheckoutAddress>('address', { required: true })
</script>

<template>
  <div data-checkout-address-fields class="mt-4 grid gap-4 grid-cols-1 sm:grid-cols-2">
    <UFormField label="Destinatario" required :error="errors.shippingRecipientName">
      <UInput v-model="address.recipientName" class="w-full" autocomplete="shipping name" />
    </UFormField>
    <UFormField label="Empresa" hint="opcional">
      <UInput v-model="address.companyName" class="w-full" autocomplete="shipping organization" />
    </UFormField>
    <UFormField label="Teléfono de entrega" required :error="errors.shippingPhone">
      <UInput v-model="address.phone" type="tel" inputmode="tel" class="w-full" autocomplete="shipping tel" />
    </UFormField>
    <UFormField label="Dirección" required :error="errors.shippingLine1">
      <UInput v-model="address.line1" class="w-full" autocomplete="shipping address-line1" />
    </UFormField>
    <UFormField label="Piso, puerta, nave…" hint="opcional" class="sm:col-span-2">
      <UInput v-model="address.line2" class="w-full" autocomplete="shipping address-line2" />
    </UFormField>
    <UFormField label="Código postal" required :error="errors.shippingPostalCode">
      <UInput v-model="address.postalCode" inputmode="numeric" class="w-full" autocomplete="shipping postal-code" />
    </UFormField>
    <UFormField label="Población" required :error="errors.shippingCity">
      <UInput v-model="address.city" class="w-full" autocomplete="shipping address-level2" />
    </UFormField>
    <UFormField label="Provincia">
      <UInput v-model="address.region" class="w-full" autocomplete="shipping address-level1" />
    </UFormField>
    <slot name="market" />
    <UFormField label="Notas para el reparto" hint="opcional">
      <UInput v-model="address.instructions" placeholder="Horario, muelle de carga…" class="w-full" />
    </UFormField>
  </div>
</template>
