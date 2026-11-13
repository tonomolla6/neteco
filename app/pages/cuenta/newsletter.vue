<script setup lang="ts">
import NewsletterPreferencesPanel from '../../components/NewsletterPreferencesPanel.vue'
import { z } from 'zod'
definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Temas y frecuencia newsletter', robots: 'noindex, nofollow, noarchive' })
const { ready, loggedIn, user, session } = useUserSession(),
  runtime = useRuntimeConfig().public.serverRuntime
const actor = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
const authorize = () =>
  runtime === 'cloudflare' &&
  ready.value === true &&
  loggedIn.value === true &&
  user.value?.emailVerified === true &&
  z.string().uuid().safeParse(actor.value).success &&
  z.string().email().safeParse(user.value?.email).success &&
  z.string().uuid().safeParse(session.value?.sessionId).success &&
  Number.isSafeInteger(session.value?.sessionVersion) &&
  Number(session.value?.sessionVersion) > 0
const privateScope = computed(() =>
  JSON.stringify([
    ready.value,
    loggedIn.value,
    actor.value,
    user.value?.email,
    user.value?.emailVerified,
    user.value?.mfaVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
const HOW = [
  {
    icon: 'i-lucide-calendar-clock',
    title: 'Cada cuánto',
    text: 'Cuando haya novedades, una vez por semana o una vez al mes. Nunca más de lo que elijas.'
  },
  {
    icon: 'i-lucide-tags',
    title: 'De qué temas',
    text: 'Marca solo los temas que te interesan. Si no marcas ninguno, recibes el boletín general.'
  },
  {
    icon: 'i-lucide-moon',
    title: 'A qué horas no',
    text: 'Indica una franja de silencio y no te escribiremos dentro de ella.'
  }
]
</script>
<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Boletín: temas y frecuencia"
      description="Elige de qué temas quieres que te escribamos y cada cuánto. Puedes cambiarlo o darte de baja cuando quieras."
    />
    <NewsletterPreferencesPanel
      v-if="authorize()"
      :key="privateScope"
      endpoint="/api/account/newsletter/preferences"
      :actor-id="actor"
      :authorize="authorize"
    />
    <UiSurface v-else>
      <p>Para elegir temas y frecuencia, inicia sesión con tu cuenta y confirma tu correo.</p>
    </UiSurface>
    <!-- Qué se puede elegir: visible siempre, también si el boletín no está disponible -->
    <section aria-labelledby="newsletter-how">
      <h2 id="newsletter-how" class="pb-3">Qué puedes elegir</h2>
      <ul class="grid gap-3 sm:grid-cols-3">
        <li
          v-for="item in HOW"
          :key="item.title"
          class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
        >
          <span class="grid size-10 place-items-center rounded-full bg-neteco-50 text-neteco-700">
            <UIcon :name="item.icon" class="size-5" />
          </span>
          <p class="mt-3 font-semibold text-[var(--text-strong)]">{{ item.title }}</p>
          <p class="mt-1 text-sm text-[var(--text-muted)]">{{ item.text }}</p>
        </li>
      </ul>
    </section>
    <UiSurface tone="sunken" padding="sm">
      <p class="text-sm text-[var(--text)]">
        ¿Todavía no recibes el boletín? Suscríbete con el formulario «Boletín» del pie de página y confirma el correo
        que te enviaremos. Los correos sobre pedidos y reposición están en
        <NuxtLink to="/cuenta/comunicaciones">Avisos y privacidad</NuxtLink>, y los de SMS y WhatsApp en
        <NuxtLink to="/cuenta/preferencias-mensajes">SMS y WhatsApp</NuxtLink>.
      </p>
    </UiSurface>
  </div>
</template>
