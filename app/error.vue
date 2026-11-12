<script setup lang="ts">
import type { NuxtError } from '#app'

/**
 * Página de error de la tienda (404, 410, 401, 403, 500, 503…).
 *
 * Un error es un momento en el que el cliente está a punto de irse. La página le dice qué
 * ha pasado en su idioma, sin el código como protagonista, y le da tres salidas: buscar el
 * producto aquí mismo, ir a una sección útil o hablar con una persona.
 */
const props = defineProps<{ error: NuxtError }>()
const status = computed(() => props.error?.statusCode ?? 500)
const seo = computed(() => errorPageSeo(status.value))

useSeoMeta({
  title: () => seo.value.title,
  description: () => seo.value.description,
  robots: 'noindex, nofollow',
  ogTitle: () => `${seo.value.title} · NETECO`,
  ogDescription: () => seo.value.description,
  twitterTitle: () => `${seo.value.title} · NETECO`,
  twitterDescription: () => seo.value.description
})

const { phone, email, terms } = useCommercialTerms()
const photo = computed(() => homeImage('error-almacen'))
const route = useRoute()

const copy = computed(() => {
  switch (status.value) {
    case 404:
      return {
        title: 'No encontramos esta página',
        text: 'Puede que el enlace haya cambiado o que el producto ya no esté en el catálogo. Búscalo aquí o sigue por una de estas secciones.',
        kind: 'missing' as const
      }
    case 410:
      return {
        title: 'Este producto ya no está en el catálogo',
        text: 'Lo hemos retirado de la tienda. Busca una alternativa aquí o pregúntanos: seguro que tenemos algo parecido.',
        kind: 'missing' as const
      }
    case 401:
      return {
        title: 'Inicia sesión para ver esta página',
        text: 'Esta sección es de tu cuenta. Entra con tu correo y contraseña y te llevamos de vuelta.',
        kind: 'auth' as const
      }
    case 403:
      return {
        title: 'Esta página no está disponible con tu cuenta',
        text: 'Si crees que deberías poder verla, escríbenos y lo revisamos.',
        kind: 'auth' as const
      }
    case 503:
      return {
        title: 'La tienda vuelve en unos minutos',
        text: 'Estamos haciendo una revisión. Prueba de nuevo en un rato; si tienes prisa, llámanos y te tomamos el pedido.',
        kind: 'server' as const
      }
    default:
      return {
        title: 'Algo ha fallado por nuestra parte',
        text: 'No es cosa tuya. Vuelve a intentarlo en unos segundos; si sigue igual, llámanos y te tomamos el pedido por teléfono.',
        kind: 'server' as const
      }
  }
})

const shortcuts = [
  { to: '/catalogo', label: 'Todo el catálogo', text: 'Por familias y marcas', icon: 'i-lucide-layout-grid' },
  { to: '/pedido-rapido', label: 'Pedido rápido', text: 'Pide por referencia', icon: 'i-lucide-list-plus' },
  { to: '/cuenta/pedidos', label: 'Mis pedidos', text: 'Estado y repetir', icon: 'i-lucide-package' },
  { to: '/ayuda', label: 'Ayuda', text: 'Envíos, pagos y devoluciones', icon: 'i-lucide-life-buoy' }
]

function go(path: string) {
  return clearError({ redirect: path })
}

function retry() {
  if (import.meta.client) window.location.reload()
}

const loginPath = computed(() => `/login?redirect=${encodeURIComponent(route.fullPath || '/')}`)
</script>

<template>
  <div class="flex min-h-screen flex-col bg-[var(--canvas)]">
    <!-- cabecera mínima: no depende del catálogo, que puede ser justo lo que ha fallado -->
    <header class="border-b border-[var(--border)] bg-white">
      <div class="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <a href="/" aria-label="NETECO, ir al inicio" class="flex items-center gap-2" @click.prevent="go('/')">
          <img src="/logo-figura.svg" alt="" width="34" height="36" class="h-8 w-auto" />
          <img src="/logo-texto.svg" alt="NETECO" width="140" height="24" class="h-5 w-auto sm:h-6" />
        </a>
        <a
          v-if="phone"
          :href="phone.href"
          class="flex h-11 items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm font-semibold text-[var(--text-strong)] hover:bg-[var(--surface-sunken)]"
        >
          <UIcon name="i-lucide-phone" class="size-4 text-[var(--text-muted)]" />
          {{ phone.display }}
        </a>
      </div>
    </header>

    <main id="contenido-principal" class="flex-1">
      <div
        class="mx-auto grid max-w-[1200px] items-center gap-8 px-4 py-8 sm:px-6 sm:py-14 lg:grid-cols-[6fr_5fr] lg:gap-14"
      >
        <div class="min-w-0">
          <p class="text-sm font-medium text-[var(--text-muted)]">Error {{ status }}</p>
          <h1 class="mt-2 text-[28px] font-bold leading-tight text-[var(--text-strong)] sm:text-4xl">
            {{ copy.title }}
          </h1>
          <p class="mt-3 max-w-xl text-base text-[var(--text)] sm:text-lg">{{ copy.text }}</p>

          <div v-if="copy.kind !== 'auth'" class="mt-6 max-w-xl">
            <SearchBox prominent size="xl" placeholder="Busca un producto o una referencia" />
          </div>

          <div class="mt-6 flex flex-wrap gap-3">
            <UButton v-if="copy.kind === 'server'" size="xl" icon="i-lucide-refresh-cw" @click="retry">
              Volver a intentarlo
            </UButton>
            <UButton v-else-if="status === 401" size="xl" icon="i-lucide-log-in" @click="go(loginPath)">
              Iniciar sesión
            </UButton>
            <UButton v-else size="xl" icon="i-lucide-layout-grid" @click="go('/catalogo')">Ver el catálogo</UButton>
            <UButton size="xl" color="neutral" variant="outline" icon="i-lucide-house" @click="go('/')">
              Ir al inicio
            </UButton>
          </div>
        </div>

        <!-- imagen amable; sin fotografía publicada, la figura de la marca sobre su color -->
        <div
          class="relative order-first aspect-[3/2] overflow-hidden rounded-[var(--radius-panel)] bg-neteco-50 lg:order-none"
        >
          <img
            v-if="photo"
            :src="photo.src"
            :alt="photo.alt"
            :width="photo.width"
            :height="photo.height"
            class="h-full w-full object-cover"
          />
          <div v-else class="flex h-full items-center justify-center" aria-hidden="true">
            <div class="relative">
              <img src="/logo-figura.svg" alt="" width="120" height="128" class="h-28 w-auto opacity-90 sm:h-36" />
              <span
                class="absolute -bottom-3 -right-6 grid size-14 place-items-center rounded-full bg-white text-neteco-700 shadow-[var(--shadow-overlay)]"
              >
                <UIcon
                  :name="
                    copy.kind === 'server'
                      ? 'i-lucide-wrench'
                      : copy.kind === 'auth'
                        ? 'i-lucide-lock'
                        : 'i-lucide-search'
                  "
                  class="size-6"
                />
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- salidas útiles -->
      <div class="mx-auto max-w-[1200px] px-4 pb-10 sm:px-6">
        <h2 class="text-lg font-bold text-[var(--text-strong)]">Quizá te sirva</h2>
        <ul class="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <li v-for="item in shortcuts" :key="item.to">
            <a
              :href="item.to"
              class="group flex h-full items-start gap-3 rounded-[var(--radius-surface)] border border-[var(--border)] bg-white p-4 transition hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-overlay)]"
              @click.prevent="go(item.to)"
            >
              <UIcon :name="item.icon" class="mt-0.5 size-5 shrink-0 text-[var(--text-muted)]" />
              <span class="min-w-0">
                <span class="block font-semibold text-[var(--text-strong)] group-hover:text-[var(--link)]">{{
                  item.label
                }}</span>
                <span class="block text-[13px] text-[var(--text-muted)]">{{ item.text }}</span>
              </span>
            </a>
          </li>
        </ul>

        <div
          class="mt-4 flex flex-col gap-4 rounded-[var(--radius-panel)] bg-neteco-900 p-5 text-white sm:flex-row sm:items-center sm:justify-between sm:p-6"
        >
          <div>
            <p class="font-display text-lg font-bold text-white">¿Prefieres hablar con alguien?</p>
            <p class="mt-1 text-[15px] text-neteco-100">
              Te atiende una persona<template v-if="terms.supportHours">, {{ terms.supportHours }}</template
              >.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <a
              v-if="phone"
              :href="phone.href"
              class="inline-flex h-12 items-center gap-2 rounded-[var(--radius-control)] bg-white px-5 font-semibold text-neteco-900 hover:bg-neteco-50"
            >
              <UIcon name="i-lucide-phone" class="size-4" /> {{ phone.display }}
            </a>
            <a
              :href="`mailto:${email}`"
              class="inline-flex h-12 items-center gap-2 rounded-[var(--radius-control)] border border-white/50 px-5 font-semibold text-white hover:bg-white/10"
            >
              <UIcon name="i-lucide-mail" class="size-4" /> {{ email }}
            </a>
          </div>
        </div>
      </div>
    </main>

    <footer class="border-t border-[var(--border)] bg-white">
      <div
        class="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-3 px-4 py-4 text-[13px] text-[var(--text-muted)] sm:px-6"
      >
        <p>NETECO · Suministros profesionales de limpieza, higiene y menaje</p>
        <nav aria-label="Información legal" class="flex gap-4">
          <a href="/aviso-legal" class="hover:underline" @click.prevent="go('/aviso-legal')">Aviso legal</a>
          <a href="/privacidad" class="hover:underline" @click.prevent="go('/privacidad')">Privacidad</a>
        </nav>
      </div>
    </footer>
  </div>
</template>
