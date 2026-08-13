<script setup lang="ts">
useSeoMeta({ title: 'Confirmar newsletter · NETECO', robots: 'noindex, nofollow' })
const route = useRoute()
const token = computed(() => String(route.query.token ?? ''))
const status = ref<'ready' | 'loading' | 'success' | 'error'>(token.value.length >= 32 ? 'ready' : 'error')
const message = ref(token.value.length >= 32 ? '' : 'El enlace está incompleto.')

async function confirm() {
  status.value = 'loading'
  try {
    await $fetch('/api/newsletter/confirm', { method: 'POST', body: { token: token.value } })
    status.value = 'success'
  } catch (error) {
    status.value = 'error'
    message.value = apiErrorMessage(error, 'El enlace no es válido o ha caducado.')
  }
}
</script>

<template>
  <main class="mx-auto max-w-xl px-4 py-20 text-center">
    <UIcon name="i-lucide-mail-check" class="mx-auto size-12 text-neteco-600" />
    <h1 class="mt-4 text-3xl font-bold text-slate-900">Confirma tu suscripción</h1>
    <p class="mt-3 text-slate-600">Solo enviaremos novedades comerciales después de esta confirmación.</p>
    <UButton v-if="status === 'ready'" class="mt-6" size="lg" @click="confirm">Confirmar newsletter</UButton>
    <UButton v-else-if="status === 'loading'" class="mt-6" size="lg" loading disabled>Confirmando</UButton>
    <UAlert
      v-else-if="status === 'success'"
      class="mt-6 text-left"
      color="success"
      title="Suscripción confirmada"
      description="Ya puedes recibir la newsletter. Cada mensaje incluirá una baja directa sin necesidad de iniciar sesión."
    />
    <UAlert v-else class="mt-6 text-left" color="error" title="No se ha podido confirmar" :description="message" />
  </main>
</template>
