<script setup lang="ts">
useSeoMeta({ title: 'Baja de newsletter · NETECO', robots: 'noindex, nofollow' })
const route = useRoute()
const token = computed(() => String(route.query.token ?? ''))
const status = ref<'ready' | 'loading' | 'success' | 'error'>(token.value.length >= 32 ? 'ready' : 'error')
const message = ref(token.value.length >= 32 ? '' : 'El enlace está incompleto.')

async function unsubscribe() {
  status.value = 'loading'
  try {
    await $fetch('/api/newsletter/unsubscribe', { method: 'POST', body: { token: token.value } })
    status.value = 'success'
  } catch (error) {
    status.value = 'error'
    message.value = apiErrorMessage(error, 'El enlace no es válido o ha caducado.')
  }
}
</script>

<template>
  <main class="mx-auto max-w-xl px-4 py-20 text-center">
    <UIcon name="i-lucide-mail-x" class="mx-auto size-12 text-neteco-600" />
    <h1 class="mt-4 text-3xl font-bold text-slate-900">Dejar de recibir la newsletter</h1>
    <p class="mt-3 text-slate-600">
      La baja comercial es inmediata y no afecta a emails de pedidos, facturas o seguridad.
    </p>
    <UButton v-if="status === 'ready'" class="mt-6" size="lg" color="error" @click="unsubscribe"
      >Confirmar baja</UButton
    >
    <UButton v-else-if="status === 'loading'" class="mt-6" size="lg" loading disabled>Procesando</UButton>
    <UAlert
      v-else-if="status === 'success'"
      class="mt-6 text-left"
      color="success"
      title="Baja completada"
      description="No recibirás más comunicaciones comerciales de esta suscripción."
    />
    <UAlert v-else class="mt-6 text-left" color="error" title="No se ha podido tramitar" :description="message" />
  </main>
</template>
