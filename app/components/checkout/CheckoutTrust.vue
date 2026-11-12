<script setup lang="ts">
/**
 * La confianza se pone donde está la duda: el momento anterior a introducir la tarjeta.
 * Tres hechos verificables, no adornos: quién cobra, qué documento recibe y con quién
 * habla si algo va mal.
 */
defineProps<{ phone: string; email: string; hours: string }>()
</script>

<template>
  <ul class="mt-4 space-y-2 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-muted)]">
    <li class="flex items-start gap-2">
      <UIcon name="i-lucide-shield-check" class="mt-px size-4 shrink-0 text-neteco-600" />
      El pago se hace en la pasarela del banco. NETECO no ve ni guarda tu tarjeta.
    </li>
    <li class="flex items-start gap-2">
      <UIcon name="i-lucide-file-text" class="mt-px size-4 shrink-0 text-neteco-600" />
      Recibirás la factura por email. Para factura de empresa, indica razón social y NIF.
    </li>
    <li class="flex items-start gap-2">
      <UIcon :name="phone ? 'i-lucide-phone' : 'i-lucide-mail'" class="mt-px size-4 shrink-0 text-neteco-600" />
      {{ phone || email }}<template v-if="phone && hours"> · {{ hours }}</template>
    </li>
  </ul>
</template>
