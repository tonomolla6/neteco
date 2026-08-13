<script setup lang="ts">
useSeoMeta({ title: 'Recuperar contraseña', robots: 'noindex, nofollow' })

const email = ref('')
const loading = ref(false)
const sent = ref(false)
const errorMsg = ref('')

async function submit() {
  loading.value = true
  errorMsg.value = ''
  try {
    await $fetch('/api/auth/forgot-password', { method: 'POST', body: { email: email.value } })
    sent.value = true
  } catch (error) {
    errorMsg.value = apiErrorMessage(error, 'No se ha podido procesar la solicitud.')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="mx-auto max-w-md px-4 py-16">
    <section class="rounded-2xl border border-slate-200 bg-white p-8">
      <h1 class="text-2xl font-bold text-slate-900">Recuperar contraseña</h1>
      <p class="mt-2 text-sm text-slate-600">Te enviaremos un enlace de un solo uso que caduca en 30 minutos.</p>
      <UAlert
        v-if="sent"
        class="mt-6"
        color="success"
        title="Revisa tu correo"
        description="Si la cuenta existe, recibirás el enlace en unos minutos."
      />
      <form v-else class="mt-6 space-y-4" @submit.prevent="submit">
        <UFormField label="Email" required>
          <UInput v-model="email" type="email" autocomplete="email" class="w-full" />
        </UFormField>
        <UAlert v-if="errorMsg" color="error" :title="errorMsg" />
        <UButton type="submit" block :loading="loading">Enviar enlace</UButton>
      </form>
    </section>
  </main>
</template>
