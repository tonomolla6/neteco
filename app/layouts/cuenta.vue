<script setup lang="ts">
/**
 * Shell del área de cliente.
 *
 * Antes `/cuenta` era una sola ruta de 583 líneas que cargaba siete recursos de API
 * y apilaba once secciones y seis formularios en 3.309 px (5.802 px en móvil), sin
 * ningún tipo de navegación. La tarea que trae al cliente —ver un pedido— quedaba la
 * última, por debajo de la configuración de privacidad.
 *
 * Baymard mide que el 96 % de las tiendas no ofrecen las rutas clave en el menú de
 * cuenta. Aquí están las siete, siempre visibles, en el orden en que se usan.
 */
const { user, clear } = useUserSession()
const runtime = useRuntimeConfig()

/** Las siete secciones de siempre, en el orden en que se usan. */
const primary = [
  { to: '/cuenta', label: 'Inicio', icon: 'i-lucide-layout-dashboard', exact: true },
  { to: '/cuenta/pedidos', label: 'Pedidos', icon: 'i-lucide-package' },
  { to: '/cuenta/listas', label: 'Listas', icon: 'i-lucide-list-checks' },
  { to: '/cuenta/direcciones', label: 'Direcciones', icon: 'i-lucide-map-pin' },
  { to: '/cuenta/datos', label: 'Empresa y facturación', icon: 'i-lucide-building-2' },
  { to: '/cuenta/seguridad', label: 'Acceso y seguridad', icon: 'i-lucide-shield-check' },
  { to: '/cuenta/comunicaciones', label: 'Avisos', icon: 'i-lucide-bell' }
]
/** El resto de pantallas de la cuenta: accesibles, pero fuera del camino principal. */
const secondary =
  runtime.public.serverRuntime === 'cloudflare'
    ? [
        { to: '/cuenta/newsletter', label: 'Temas y frecuencia', icon: 'i-lucide-mails' },
        { to: '/cuenta/preferencias-mensajes', label: 'Preferencias de mensajes', icon: 'i-lucide-message-circle' },
        { to: '/cuenta/notificaciones', label: 'Centro de notificaciones', icon: 'i-lucide-bell' },
        { to: '/cuenta/avisos-productos', label: 'Avisos de productos', icon: 'i-lucide-bell' },
        { to: '/cuenta/recuperar-carrito', label: 'Recuperación de carrito', icon: 'i-lucide-shopping-cart' },
        { to: '/cuenta/aportaciones-productos', label: 'Reseñas y preguntas', icon: 'i-lucide-message-square' },
        { to: '/cuenta/presupuestos', label: 'Mis presupuestos', icon: 'i-lucide-file-check-2' },
        { to: '/cuenta/solicitudes-b2b', label: 'Solicitudes de empresa', icon: 'i-lucide-clipboard-list' },
        { to: '/cuenta/metodos-de-pago', label: 'Métodos de pago', icon: 'i-lucide-credit-card' },
        { to: '/cuenta/revision-promociones', label: 'Revisión de promociones', icon: 'i-lucide-shield-alert' },
        { to: '/cuenta/soporte', label: 'Mis consultas', icon: 'i-lucide-life-buoy' }
      ]
    : []
const links: Array<{ to: string; label: string; icon: string; exact?: boolean }> = [...primary, ...secondary]

const route = useRoute()
function isActive(link: (typeof links)[number]) {
  return link.exact ? route.path === link.to : route.path.startsWith(link.to)
}
const currentSecondary = computed(() => secondary.find((link) => isActive(link)))

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  // Navegación dura y no un `navigateTo` suelto: al limpiar la sesión estando en una
  // ruta protegida, el middleware `auth` se dispara y redirige a /login?redirect=/cuenta
  // antes de que la navegación a la home llegue a ejecutarse. Además así se descarta
  // todo el estado de cliente (carrito incluido), que es lo que se espera al salir.
  await navigateTo('/', { replace: true, external: true })
}
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <a
      href="#contenido-principal"
      class="fixed left-3 top-3 z-[100] -translate-y-20 rounded-[var(--radius-control)] bg-slate-950 px-4 py-2 font-semibold text-white shadow-lg transition focus:translate-y-0"
    >
      Saltar al contenido
    </a>
    <AppHeader />

    <div class="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
      <!--
        Tira de identidad de una línea. El `h1` lo pone cada página, porque describe la
        pantalla; el nombre del cliente solo identifica la sesión y no compite con él.
      -->
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pb-4">
        <p data-account-identity class="min-w-0 truncate text-[13px] text-[var(--text-muted)]">
          <span class="font-semibold text-[var(--text-strong)]">{{ user?.company || user?.name }}</span>
          · {{ user?.email }}
        </p>
        <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-log-out" @click="logout">
          Cerrar sesión
        </UButton>
      </div>

      <div class="gap-8 lg:flex">
        <!-- Escritorio: navegación lateral persistente -->
        <nav aria-label="Secciones de la cuenta" class="hidden w-56 shrink-0 lg:block">
          <ul class="sticky top-6 space-y-0.5">
            <li
              v-for="(link, index) in links"
              :key="link.to"
              :class="index === primary.length ? 'mt-3 border-t border-[var(--border)] pt-3' : ''"
            >
              <NuxtLink
                :to="link.to"
                class="flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors"
                :class="
                  isActive(link)
                    ? 'bg-neteco-50 text-neteco-800'
                    : 'text-[var(--text)] hover:bg-[var(--surface-sunken)]'
                "
                :aria-current="isActive(link) ? 'page' : undefined"
              >
                <UIcon :name="link.icon" class="size-4 shrink-0" />
                {{ link.label }}
              </NuxtLink>
            </li>
          </ul>
        </nav>

        <!-- Móvil: las secciones principales en una fila de pestañas desplazable, a un toque.
             Un desplegable cerrado dejaba Pedidos y Listas a dos. -->
        <nav
          aria-label="Secciones de la cuenta"
          data-account-tabs
          class="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-[var(--border)] px-4 lg:hidden"
        >
          <NuxtLink
            v-for="link in primary"
            :key="link.to"
            :to="link.to"
            :aria-current="isActive(link) ? 'page' : undefined"
            class="-mb-px flex min-h-11 shrink-0 items-center border-b-2 px-3 text-[15px] font-medium"
            :class="
              isActive(link)
                ? 'border-[var(--action)] text-[var(--action)]'
                : 'border-transparent text-[var(--text-muted)]'
            "
          >
            {{ link.label }}
          </NuxtLink>
        </nav>
        <div v-if="secondary.length" class="mb-5 lg:hidden">
          <USelectMenu
            :model-value="currentSecondary"
            :items="secondary"
            label-key="label"
            placeholder="Más secciones"
            class="w-full"
            @update:model-value="(link) => link && navigateTo(link.to)"
          >
            <template #leading>
              <UIcon :name="currentSecondary?.icon ?? 'i-lucide-ellipsis'" class="size-4" />
            </template>
          </USelectMenu>
        </div>

        <main id="contenido-principal" class="min-w-0 flex-1" tabindex="-1">
          <slot />
        </main>
      </div>
    </div>

    <AppFooter />
    <ConsentManager />
  </div>
</template>
