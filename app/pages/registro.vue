<script setup lang="ts">
import { NEWSLETTER_CONFIRMATION_NOTICE, NEWSLETTER_CONSENT_TEXT } from '~~/shared/newsletter'

useSeoMeta({ title: 'Crear cuenta' })
const runtime = useRuntimeConfig()

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
const registrationRequested = ref(false)

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
    errorMsg.value = 'Debes aceptar las condiciones de la cuenta.'
    return
  }
  loading.value = true
  try {
    const response = await $fetch<{ user?: unknown }>('/api/auth/register', {
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
    if (response.user) {
      await refreshSession()
      navigateTo(String(route.query.redirect ?? '/cuenta'))
    } else {
      registrationRequested.value = true
      form.password = ''
      form.password2 = ''
    }
  } catch (error) {
    errorMsg.value = apiErrorMessage(error, 'No se ha podido crear la cuenta.')
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
      <p class="mt-1 text-center text-sm text-slate-500">
        Repite un pedido en dos clics, guarda tus direcciones de entrega y descarga tus facturas.
      </p>

      <div v-if="registrationRequested" class="mt-6 space-y-4" role="status" aria-live="polite">
        <UAlert
          color="info"
          variant="subtle"
          icon="i-lucide-mail"
          title="Revisa tu correo"
          description="Si la dirección puede utilizarse, recibirás un enlace para verificarla. Después podrás iniciar sesión."
        />
        <NuxtLink to="/recuperar-clave" class="text-sm font-semibold text-neteco-600 underline">
          Si ya tienes cuenta y no recuerdas la contraseña, puedes recuperarla.
        </NuxtLink>
      </div>
      <form v-else class="mt-6 space-y-4" @submit.prevent="submit">
        <UFormField label="Nombre y apellidos" required>
          <UInput v-model="form.name" autocomplete="name" class="w-full" icon="i-lucide-user" />
        </UFormField>
        <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
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
        <PasswordField v-model="form.password" label="Contraseña" required show-rules />
        <PasswordField v-model="form.password2" label="Repite la contraseña" required :matches="form.password" />

        <UCheckbox v-model="form.termsAccepted" required label="Acepto las condiciones de la cuenta" />
        <p class="text-xs leading-relaxed text-slate-500">
          Consulta las
          <a :href="runtime.public.legalTermsUrl" target="_blank" rel="noopener" class="underline">condiciones</a> y la
          <a :href="runtime.public.privacyUrl" target="_blank" rel="noopener" class="underline"
            >información de privacidad</a
          >
          sobre el tratamiento necesario para crear y mantener tu cuenta.
        </p>
        <UCheckbox v-model="form.newsletter" :label="NEWSLETTER_CONSENT_TEXT" />
        <p v-if="form.newsletter" class="text-xs leading-relaxed text-slate-500">
          {{ NEWSLETTER_CONFIRMATION_NOTICE }}
        </p>

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
