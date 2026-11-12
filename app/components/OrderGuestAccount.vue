<script setup lang="ts">
/** Tras comprar como invitado: la cuenta se crea con los datos del pedido; solo falta la contraseña. */
const props = defineProps<{
  order: { id: string; email: string; name: string; phone: string; company: string | null }
}>()

const href = computed(() => {
  const query = new URLSearchParams({ email: props.order.email, nombre: props.order.name, telefono: props.order.phone })
  if (props.order.company) query.set('empresa', props.order.company)
  query.set('pedido', props.order.id)
  return `/registro?${query.toString()}`
})
</script>

<template>
  <UiSurface class="flex flex-col justify-between gap-3 sm:flex-row sm:items-center" padding="sm">
    <p class="text-sm text-[var(--text)]">
      <UIcon name="i-lucide-bookmark" class="inline size-4 text-neteco-700" />
      Con una cuenta tienes este pedido siempre, desde cualquier dispositivo, con sus facturas, y puedes repetirlo.
      Usamos los datos de este pedido: solo falta una contraseña.
    </p>
    <UButton :to="href" data-order-create-account variant="soft" icon="i-lucide-user-plus" class="shrink-0">
      Crear cuenta
    </UButton>
  </UiSurface>
</template>
