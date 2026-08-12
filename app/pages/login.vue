<script setup lang="ts">
useSeoMeta({ title: 'Iniciar sesión' })

const route = useRoute()
const { fetch: refreshSession } = useUserSession()

const form = reactive({ email: '', password: '' })
const mfa = reactive({ challenge: '', code: '' })
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
    if (mfa.challenge) {
      await $fetch('/api/auth/mfa/complete', {
        method: 'POST',
        body: { challenge: mfa.challenge, code: mfa.code }
      })
    } else {
      const result = await $fetch<{ mfaRequired?: boolean; challenge?: string }>('/api/auth/login', {
        method: 'POST',
        body: { ...form }
      })
      if (result.mfaRequired && result.challenge) {
        mfa.challenge = result.challenge
        return
      }
    }
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
      <img src="/logo-figura.png" alt="" class="mx-auto h-12 w-auto" />
      <h1 class="mt-4 text-center text-2xl font-bold text-slate-900">Inicia sesión</h1>
      <p class="mt-1 text-center text-sm text-slate-500">Accede a tus pedidos y compra más rápido.</p>

      <form class="mt-6 space-y-4" @submit.prevent="submit">
        <UFormField v-if="!mfa.challenge" label="Email">
          <UInput v-model="form.email" type="email" autocomplete="email" class="w-full" icon="i-lucide-mail" />
        </UFormField>
        <UFormField v-if="!mfa.challenge" label="Contraseña">
          <UInput
            v-model="form.password"
            type="password"
            autocomplete="current-password"
            class="w-full"
            icon="i-lucide-lock"
          />
        </UFormField>
        <UFormField v-else label="Código de autenticación" hint="6 dígitos o un código de recuperación">
          <UInput
            v-model="mfa.code"
            autocomplete="one-time-code"
            inputmode="numeric"
            class="w-full"
            icon="i-lucide-shield-check"
            autofocus
          />
        </UFormField>

        <UAlert
          v-if="errorMsg"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-alert-circle"
          :title="errorMsg"
        />

        <UButton type="submit" block size="lg" :loading="loading">
          {{ mfa.challenge ? 'Confirmar código' : 'Iniciar sesión' }}
        </UButton>
      </form>

      <p v-if="!mfa.challenge" class="mt-4 text-center text-sm">
        <NuxtLink to="/recuperar-clave" class="font-medium text-neteco-600 hover:text-neteco-500">
          He olvidado mi contraseña
        </NuxtLink>
      </p>

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
