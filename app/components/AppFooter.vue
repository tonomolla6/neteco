<script setup lang="ts">
import { LEGAL_PAGES } from '~~/shared/legal-pages'
import { NEWSLETTER_CONFIRMATION_NOTICE, NEWSLETTER_CONSENT_TEXT } from '~~/shared/newsletter'

const year = new Date().getFullYear()
const runtime = useRuntimeConfig()
const isProduction = runtime.public.appEnv === 'production'
const newsletterEmail = ref('')
const newsletterConsent = ref(false)
const newsletterWebsite = ref('')
const newsletterState = ref<'idle' | 'loading' | 'sent' | 'error'>('idle')

async function subscribeNewsletter() {
  newsletterState.value = 'loading'
  try {
    await $fetch('/api/newsletter/subscribe', {
      method: 'POST',
      body: {
        email: newsletterEmail.value,
        consent: newsletterConsent.value,
        source: 'footer',
        website: newsletterWebsite.value
      }
    })
    newsletterState.value = 'sent'
    newsletterEmail.value = ''
    newsletterConsent.value = false
  } catch {
    newsletterState.value = 'error'
  }
}

const { terms, email: contactEmail, phones: contactPhones } = useCommercialTerms()
/**
 * En móvil el pie medía más que muchas páginas. Los tres grupos de enlaces se pliegan tras
 * su título; desde `sm` están siempre abiertos y el botón deja de serlo a efectos visuales.
 */
type Group = 'shop' | 'help' | 'contact'
const open = reactive<Record<Group, boolean>>({ shop: false, help: false, contact: false })

function configureCookies() {
  window.dispatchEvent(new Event('neteco-open-consent'))
}
</script>

<template>
  <footer class="mt-16 bg-neteco-950 text-slate-300">
    <div
      class="mx-auto grid max-w-[1600px] grid-cols-1 gap-x-10 px-4 py-6 sm:grid-cols-3 sm:gap-y-10 sm:py-12 lg:grid-cols-4"
    >
      <div class="border-b border-white/10 sm:border-0">
        <h3 class="font-sans text-[15px] font-semibold tracking-normal text-white">
          <button
            type="button"
            data-footer-toggle
            aria-controls="footer-shop"
            :aria-expanded="open.shop"
            class="flex min-h-11 w-full items-center justify-between text-left sm:pointer-events-none sm:min-h-0"
            @click="open.shop = !open.shop"
          >
            Tienda
            <UIcon
              name="i-lucide-chevron-down"
              class="size-4 transition-transform sm:hidden"
              :class="open.shop ? 'rotate-180' : ''"
            />
          </button>
        </h3>
        <ul id="footer-shop" class="space-y-2 pb-4 text-sm sm:mt-3 sm:block sm:pb-0" :class="open.shop ? '' : 'hidden'">
          <li><NuxtLink to="/catalogo" class="hover:text-white">Todo el catálogo</NuxtLink></li>
          <li><NuxtLink to="/pedido-rapido" class="hover:text-white">Pedido rápido por referencia</NuxtLink></li>
          <li><NuxtLink to="/cuenta/listas" class="hover:text-white">Listas</NuxtLink></li>
          <li v-if="runtime.public.serverRuntime === 'cloudflare'">
            <NuxtLink to="/recursos" class="hover:text-white">Guías y recursos profesionales</NuxtLink>
          </li>
        </ul>
      </div>

      <div class="border-b border-white/10 sm:border-0">
        <h3 class="font-sans text-[15px] font-semibold tracking-normal text-white">
          <button
            type="button"
            data-footer-toggle
            aria-controls="footer-help"
            :aria-expanded="open.help"
            class="flex min-h-11 w-full items-center justify-between text-left sm:pointer-events-none sm:min-h-0"
            @click="open.help = !open.help"
          >
            Ayuda
            <UIcon
              name="i-lucide-chevron-down"
              class="size-4 transition-transform sm:hidden"
              :class="open.help ? 'rotate-180' : ''"
            />
          </button>
        </h3>
        <ul id="footer-help" class="space-y-2 pb-4 text-sm sm:mt-3 sm:block sm:pb-0" :class="open.help ? '' : 'hidden'">
          <li><NuxtLink to="/envios" class="hover:text-white">Envíos y reparto</NuxtLink></li>
          <li><NuxtLink to="/formas-de-pago" class="hover:text-white">Formas de pago</NuxtLink></li>
          <li><NuxtLink to="/devoluciones" class="hover:text-white">Devoluciones</NuxtLink></li>
          <li><NuxtLink to="/contacto" class="hover:text-white">Contacto y soporte</NuxtLink></li>
          <li><NuxtLink to="/ayuda" class="hover:text-white">Centro de ayuda</NuxtLink></li>
          <li><NuxtLink to="/accesibilidad" class="hover:text-white">Accesibilidad</NuxtLink></li>
          <li><a href="https://neteco.es" target="_blank" rel="noopener" class="hover:text-white">Quiénes somos</a></li>
          <li v-for="page in LEGAL_PAGES" :key="page.path">
            <NuxtLink :to="page.path" class="hover:text-white">{{ page.label }}</NuxtLink>
          </li>
          <li>
            <button class="hover:text-white" @click="configureCookies">Configurar cookies</button>
          </li>
        </ul>
      </div>

      <div class="border-b border-white/10 sm:border-0">
        <h3 class="font-sans text-[15px] font-semibold tracking-normal text-white">
          <button
            type="button"
            data-footer-toggle
            aria-controls="footer-contact"
            :aria-expanded="open.contact"
            class="flex min-h-11 w-full items-center justify-between text-left sm:pointer-events-none sm:min-h-0"
            @click="open.contact = !open.contact"
          >
            Contacto
            <UIcon
              name="i-lucide-chevron-down"
              class="size-4 transition-transform sm:hidden"
              :class="open.contact ? 'rotate-180' : ''"
            />
          </button>
        </h3>
        <ul
          id="footer-contact"
          class="space-y-2 pb-4 text-sm sm:mt-3 sm:block sm:pb-0"
          :class="open.contact ? '' : 'hidden'"
        >
          <li class="flex items-center gap-2">
            <UIcon name="i-lucide-map-pin" class="size-4 text-slate-400" /> Ontinyent, Valencia
          </li>
          <li v-for="phone in contactPhones" :key="phone.href">
            <a :href="phone.href" class="flex items-center gap-2 hover:text-white"
              ><UIcon name="i-lucide-phone" class="size-4 text-slate-400" /> {{ phone.display }}</a
            >
          </li>
          <li>
            <a :href="`mailto:${contactEmail}`" class="flex items-center gap-2 hover:text-white"
              ><UIcon name="i-lucide-mail" class="size-4 text-slate-400" /> {{ contactEmail }}</a
            >
          </li>
          <li v-if="terms.supportHours" class="flex items-start gap-2">
            <UIcon name="i-lucide-clock" class="mt-0.5 size-4 shrink-0 text-slate-400" />
            <span>Atención {{ terms.supportHours }}</span>
          </li>
          <li class="flex items-start gap-2 text-slate-400">
            <UIcon name="i-lucide-truck" class="mt-0.5 size-4 shrink-0" /> Reparto propio en Ontinyent y la Vall
            d'Albaida
          </li>
        </ul>
      </div>

      <!-- El boletín va el último y en una línea: es lo menos urgente de lo que ofrece el pie. -->
      <div class="pt-5 sm:col-span-3 sm:pt-0 lg:col-span-1">
        <div class="flex items-center gap-2">
          <img src="/logo-figura.svg" alt="" width="34" height="36" loading="lazy" class="h-9 w-auto" />
          <span class="text-lg font-bold text-white">NETECO</span>
        </div>
        <p class="mt-3 hidden text-sm leading-relaxed text-slate-400 sm:block">
          <template v-if="terms.foundedYear">Desde {{ terms.foundedYear }} suministrando</template
          ><template v-else>Suministramos</template> higiene, limpieza y equipamiento a empresas, hostelería y
          colectividades de la Vall d'Albaida.
        </p>
        <form class="mt-4 space-y-2" @submit.prevent="subscribeNewsletter">
          <label for="footer-newsletter-email" class="block text-sm font-semibold text-white">Boletín</label>
          <div class="flex gap-2">
            <UInput
              id="footer-newsletter-email"
              v-model="newsletterEmail"
              type="email"
              autocomplete="email"
              required
              placeholder="tu@email.es"
              class="min-w-0 flex-1"
            />
            <UButton type="submit" :loading="newsletterState === 'loading'">Suscribirme</UButton>
          </div>
          <label class="flex items-start gap-2 text-xs leading-relaxed text-slate-400">
            <input v-model="newsletterConsent" required type="checkbox" class="mt-0.5 accent-neteco-500" />
            <span>{{ NEWSLETTER_CONSENT_TEXT }}</span>
          </label>
          <label class="sr-only" aria-hidden="true">
            Sitio web
            <input v-model="newsletterWebsite" tabindex="-1" autocomplete="off" />
          </label>
          <p v-if="newsletterState === 'sent'" role="status" class="text-xs text-green-300">
            {{ NEWSLETTER_CONFIRMATION_NOTICE }}
          </p>
          <p v-else-if="newsletterState === 'error'" role="alert" class="text-xs text-red-300">
            No se ha podido tramitar la solicitud. Revisa los datos e inténtalo de nuevo.
          </p>
        </form>
      </div>
    </div>

    <div class="border-t border-white/10">
      <div
        class="mx-auto flex max-w-[1600px] flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-slate-400 sm:flex-row"
      >
        <p data-footer-legal class="text-center sm:text-left">
          © {{ year }} Maria Carmen González Nacher<template v-if="terms.companyTaxId">
            · NIF {{ terms.companyTaxId }}</template
          ><template v-if="terms.companyAddress"> · {{ terms.companyAddress }}</template> · Todos los derechos
          reservados.
        </p>
        <p v-if="!isProduction" class="rounded-[var(--radius-control)] bg-white/5 px-3 py-1">
          Demo interna · los productos y precios no son reales
        </p>
      </div>
    </div>
  </footer>
</template>
