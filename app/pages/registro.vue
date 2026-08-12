<script setup lang="ts">
useSeoMeta({ title: 'Crear cuenta' })

const route = useRoute()
const { fetch: refreshSession } = useUserSession()

const form = reactive({
  name: '',
  company: '',
  phone: '',
  email: String(route.query.email ?? ''),
  password: '',
  password2: '',
  termsAccepted: false,
  newsletter: false
})
const loading = ref(false)
const errorMsg = ref('')

async function submit() {
  errorMsg.value = ''
  if (!form.name || !form.email || !form.password) {
    errorMsg.value = 'Rellena al menos nombre, email y contraseña.'
    return
  }
  if (form.password.length < 12 || !/[a-záéíóúñ]/i.test(form.password) || !/\d/.test(form.password)) {
    errorMsg.value = 'La contraseña debe tener al menos 12 caracteres, una letra y un número.'
    return
  }
  if (form.password !== form.password2) {
    errorMsg.value = 'Las contraseñas no coinciden.'
    return
  }
  if (!form.termsAccepted) {
    errorMsg.value = 'Debes aceptar las condiciones de la cuenta y la política de privacidad.'
    return
  }
  loading.value = true
  try {
    await $fetch('/api/auth/register', {
      method: 'POST',
      body: {
        name: form.name,
        email: form.email,
        password: form.password,
        phone: form.phone || undefined,
        company: form.company || undefined,
        termsAccepted: form.termsAccepted,
        newsletter: form.newsletter
      }
    })
    await refreshSession()
    navigateTo(String(route.query.redirect ?? '/cuenta'))
  } catch (e: any) {
    errorMsg.value = e?.data?.statusMessage ?? 'No se ha podido crear la cuenta.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-md px-4 py-14">
    <div class="rounded-2xl border border-slate-200 bg-white p-8">
      <img src="/logo-figura.png" alt="" class="mx-auto h-12 w-auto" />
      <h1 class="mt-4 text-center text-2xl font-bold text-slate-900">Crea tu cuenta</h1>
      <p class="mt-1 text-center text-sm text-slate-500">Guarda tus datos, repite pedidos y consulta tu historial.</p>

      <form class="mt-6 space-y-4" @submit.prevent="submit">
        <UFormField label="Nombre y apellidos" required>
          <UInput v-model="form.name" autocomplete="name" class="w-full" icon="i-lucide-user" />
        </UFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Empresa" hint="opcional">
            <UInput v-model="form.company" autocomplete="organization" class="w-full" />
          </UFormField>
          <UFormField label="Teléfono" hint="opcional">
            <UInput v-model="form.phone" type="tel" inputmode="tel" autocomplete="tel" class="w-full" />
          </UFormField>
        </div>
        <UFormField label="Email" required>
          <UInput v-model="form.email" type="email" autocomplete="email" class="w-full" icon="i-lucide-mail" />
        </UFormField>
        <UFormField label="Contraseña" required hint="mínimo 12 caracteres, con letras y números">
          <UInput
            v-model="form.password"
            type="password"
            autocomplete="new-password"
            class="w-full"
            icon="i-lucide-lock"
          />
        </UFormField>
        <UFormField label="Repite la contraseña" required>
          <UInput
            v-model="form.password2"
            type="password"
            autocomplete="new-password"
            class="w-full"
            icon="i-lucide-lock"
          />
        </UFormField>

        <UCheckbox
          v-model="form.termsAccepted"
          required
          label="Acepto las condiciones de la cuenta y la política de privacidad"
        />
        <UCheckbox v-model="form.newsletter" label="Quiero recibir novedades por email (opcional)" />

        <UAlert v-if="errorMsg" color="error" variant="subtle" icon="i-lucide-alert-circle" :title="errorMsg" />

        <UButton type="submit" block size="lg" :loading="loading">Crear cuenta</UButton>
      </form>

      <p class="mt-6 text-center text-sm text-slate-500">
        ¿Ya tienes cuenta?
        <NuxtLink
          :to="`/login${route.query.redirect ? `?redirect=${encodeURIComponent(String(route.query.redirect))}` : ''}`"
          class="font-semibold text-neteco-600 hover:text-neteco-500"
        >
          Inicia sesión
        </NuxtLink>
      </p>
    </div>
  </div>
</template>
