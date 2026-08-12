<script setup lang="ts">
const route = useRoute()
useSeoMeta({ title: 'Nueva contraseña', robots: 'noindex, nofollow' })

const form = reactive({ password: '', repeat: '' })
const loading = ref(false)
const done = ref(false)
const errorMsg = ref('')

async function submit() {
  errorMsg.value = ''
  if (form.password.length < 12 || !/[a-záéíóúñ]/i.test(form.password) || !/\d/.test(form.password)) {
    errorMsg.value = 'Usa al menos 12 caracteres, con una letra y un número.'
    return
  }
  if (form.password !== form.repeat) {
    errorMsg.value = 'Las contraseñas no coinciden.'
    return
  }
  loading.value = true
  try {
    await $fetch('/api/auth/reset-password', {
      method: 'POST',
      body: { token: String(route.query.token ?? ''), password: form.password }
    })
    done.value = true
  } catch (error: any) {
    errorMsg.value = error?.data?.statusMessage ?? 'El enlace no es válido o ha caducado.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="mx-auto max-w-md px-4 py-16">
    <section class="rounded-2xl border border-slate-200 bg-white p-8">
      <h1 class="text-2xl font-bold text-slate-900">Elige una nueva contraseña</h1>
      <div v-if="done" class="mt-6">
        <UAlert color="success" title="Contraseña actualizada" description="Se han cerrado las sesiones anteriores." />
        <UButton to="/login" block class="mt-4">Iniciar sesión</UButton>
      </div>
      <form v-else class="mt-6 space-y-4" @submit.prevent="submit">
        <UFormField label="Nueva contraseña" hint="mínimo 12 caracteres, con letras y números">
          <UInput v-model="form.password" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UFormField label="Repite la contraseña">
          <UInput v-model="form.repeat" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UAlert v-if="errorMsg" color="error" :title="errorMsg" />
        <UButton type="submit" block :loading="loading">Guardar contraseña</UButton>
      </form>
    </section>
  </main>
</template>
