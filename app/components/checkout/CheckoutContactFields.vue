<script setup lang="ts">
export interface CheckoutContact {
  name: string
  company: string
  nif: string
  email: string
  phone: string
}

defineProps<{ errors: Record<string, string> }>()
// El objeto es del formulario de la página: los campos se editan en su sitio.
const contact = defineModel<CheckoutContact>('contact', { required: true })
</script>

<template>
  <div data-checkout-contact-fields class="mt-5 grid gap-4 grid-cols-1 sm:grid-cols-2">
    <UFormField label="Email" required class="sm:col-span-2" :error="errors.email">
      <UInput v-model="contact.email" type="email" inputmode="email" class="w-full" autocomplete="email" />
    </UFormField>
    <UFormField label="Teléfono" required :error="errors.phone">
      <UInput v-model="contact.phone" type="tel" inputmode="tel" class="w-full" autocomplete="tel" />
    </UFormField>
    <UFormField label="Nombre y apellidos" required :error="errors.name">
      <UInput v-model="contact.name" class="w-full" autocomplete="name" />
    </UFormField>
  </div>
</template>
