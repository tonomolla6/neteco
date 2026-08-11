<script setup lang="ts">
useSeoMeta({ title: 'Iniciar sesión' })

const route = useRoute()
const { fetch: refreshSession } = useUserSession()

const form = reactive({ email: '', password: '' })
const loading = ref(false)
const errorMsg = ref('')

async function submit() {
  errorMsg.value = ''
  if (!form.email || !form.password) {
    errorMsg.value = 'Introduce tu email y contraseña.'
    return
  }
  loading.value = true
  try {
    await $fetch('/api/auth/login', { method: 'POST', body: { ...form } })
    await refreshSession()
    navigateTo(String(route.query.redirect ?? '/cuenta'))
  } catch (e: any) {
    errorMsg.value = e?.data?.statusMessage ?? 'No se ha podido iniciar sesión.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-md px-4 py-14">
    <div class="rounded-2xl border border-slate-200 bg-white p-8">
      <img src="/logo-figura.png" alt="" class="mx-auto h-12 w-auto" >
      <h1 class="mt-4 text-center text-2xl font-bold text-slate-900">Inicia sesión</h1>
      <p class="mt-1 text-center text-sm text-slate-500">Accede a tus pedidos y compra más rápido.</p>

      <form class="mt-6 space-y-4" @submit.prevent="submit">
        <UFormField label="Email">
          <UInput v-model="form.email" type="email" autocomplete="email" class="w-full" icon="i-lucide-mail" />
        </UFormField>
        <UFormField label="Contraseña">
          <UInput v-model="form.password" type="password" autocomplete="current-password" class="w-full" icon="i-lucide-lock" />
        </UFormField>

        <UAlert v-if="errorMsg" role="alert" color="error" variant="subtle" icon="i-lucide-alert-circle" :title="errorMsg" />

        <UButton type="submit" block size="lg" :loading="loading">Iniciar sesión</UButton>
      </form>

      <p class="mt-6 text-center text-sm text-slate-500">
        ¿Aún no tienes cuenta?
        <NuxtLink
          :to="`/registro${route.query.redirect ? `?redirect=${encodeURIComponent(String(route.query.redirect))}` : ''}`"
          class="font-semibold text-neteco-600 hover:text-neteco-500"
        >
          Regístrate
        </NuxtLink>
      </p>
    </div>
  </div>
</template>
