<script setup lang="ts">
export interface CheckoutAddress {
  recipientName: string
  companyName: string
  taxId: string
  line1: string
  line2: string
  postalCode: string
  city: string
  region: string
  countryCode: string
  phone: string
  instructions: string
}

defineProps<{ errors: Record<string, string> }>()
// El objeto es del formulario de la página: los campos se editan en su sitio.
const address = defineModel<CheckoutAddress>('address', { required: true })
</script>

<template>
  <div class="mt-5 border-t border-slate-100 pt-5">
    <h3 class="font-sans text-[15px] font-semibold tracking-normal text-[var(--text-strong)]">
      Dirección de facturación
    </h3>
    <div class="mt-4 grid gap-4 grid-cols-1 sm:grid-cols-2">
      <UFormField label="Titular / razón social" required :error="errors.billingRecipientName">
        <UInput v-model="address.recipientName" class="w-full" autocomplete="billing name" />
      </UFormField>
      <UFormField label="Empresa" hint="opcional">
        <UInput v-model="address.companyName" class="w-full" autocomplete="billing organization" />
      </UFormField>
      <UFormField label="NIF / NIE / CIF" hint="opcional" :error="errors.billingTaxId">
        <UInput v-model="address.taxId" class="w-full" />
      </UFormField>
      <UFormField label="Dirección fiscal" required :error="errors.billingLine1">
        <UInput v-model="address.line1" class="w-full" autocomplete="billing address-line1" />
      </UFormField>
      <UFormField label="Dirección adicional" hint="opcional" class="sm:col-span-2">
        <UInput v-model="address.line2" class="w-full" autocomplete="billing address-line2" />
      </UFormField>
      <UFormField label="Código postal" required :error="errors.billingPostalCode">
        <UInput v-model="address.postalCode" inputmode="numeric" class="w-full" autocomplete="billing postal-code" />
      </UFormField>
      <UFormField label="Población" required :error="errors.billingCity">
        <UInput v-model="address.city" class="w-full" autocomplete="billing address-level2" />
      </UFormField>
      <UFormField label="Provincia">
        <UInput v-model="address.region" class="w-full" autocomplete="billing address-level1" />
      </UFormField>
      <UFormField label="Teléfono" hint="opcional">
        <UInput v-model="address.phone" type="tel" class="w-full" autocomplete="billing tel" />
      </UFormField>
    </div>
  </div>
</template>
