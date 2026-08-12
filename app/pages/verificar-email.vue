<script setup lang="ts">
const route = useRoute()
const token = String(route.query.token ?? '')
const { fetch: refreshSession } = useUserSession()

useSeoMeta({ title: 'Verificar email', robots: 'noindex, nofollow' })

const status = ref<'loading' | 'success' | 'error'>('loading')
const emailChanged = ref(false)
onMounted(async () => {
  try {
    const result = await $fetch<{ emailChanged?: boolean }>('/api/auth/verify-email', {
      method: 'POST',
      body: { token }
    })
    emailChanged.value = result.emailChanged ?? false
    await refreshSession()
    status.value = 'success'
  } catch {
    status.value = 'error'
  }
})
</script>

<template>
  <main class="mx-auto max-w-lg px-4 py-20 text-center">
    <UIcon
      :name="
        status === 'loading'
          ? 'i-lucide-loader-circle'
          : status === 'success'
            ? 'i-lucide-badge-check'
            : 'i-lucide-circle-x'
      "
      class="mx-auto size-12"
      :class="
        status === 'loading'
          ? 'animate-spin text-neteco-600'
          : status === 'success'
            ? 'text-emerald-600'
            : 'text-red-600'
      "
    />
    <h1 class="mt-5 text-2xl font-bold text-slate-900">
      {{
        status === 'loading'
          ? 'Verificando…'
          : status === 'success'
            ? emailChanged
              ? 'Email actualizado'
              : 'Email verificado'
            : 'Enlace no válido'
      }}
    </h1>
    <p class="mt-2 text-slate-600">
      {{
        status === 'success'
          ? emailChanged
            ? 'El nuevo email ya está activo. Por seguridad, inicia sesión de nuevo.'
            : 'Tu cuenta ya está activa.'
          : status === 'error'
            ? 'El enlace puede haber caducado o haberse utilizado ya.'
            : 'Estamos comprobando el enlace de un solo uso.'
      }}
    </p>
    <UButton
      v-if="status !== 'loading'"
      :to="status === 'success' && !emailChanged ? '/cuenta' : '/login'"
      class="mt-6"
    >
      Continuar
    </UButton>
  </main>
</template>
