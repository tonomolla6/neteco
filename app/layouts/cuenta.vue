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

const links = [
  { to: '/cuenta', label: 'Resumen', icon: 'i-lucide-layout-dashboard', exact: true },
  { to: '/cuenta/pedidos', label: 'Pedidos', icon: 'i-lucide-package' },
  { to: '/cuenta/favoritos', label: 'Listas de compra', icon: 'i-lucide-list-checks' },
  { to: '/cuenta/direcciones', label: 'Direcciones', icon: 'i-lucide-map-pin' },
  { to: '/cuenta/datos', label: 'Datos y empresa', icon: 'i-lucide-building-2' },
  { to: '/cuenta/seguridad', label: 'Acceso y seguridad', icon: 'i-lucide-shield-check' },
  { to: '/cuenta/comunicaciones', label: 'Avisos y privacidad', icon: 'i-lucide-bell' },
  ...(runtime.public.serverRuntime === 'cloudflare'
    ? [
        { to: '/cuenta/newsletter', label: 'Temas y frecuencia', icon: 'i-lucide-mails' },
        { to: '/cuenta/avisos-productos', label: 'Avisos de productos', icon: 'i-lucide-bell' },
        { to: '/cuenta/recuperar-carrito', label: 'Recuperación de carrito', icon: 'i-lucide-shopping-cart' },
        { to: '/cuenta/aportaciones-productos', label: 'Reseñas y preguntas', icon: 'i-lucide-message-square' },
        { to: '/cuenta/presupuestos', label: 'Mis presupuestos', icon: 'i-lucide-file-check-2' },
        { to: '/cuenta/metodos-de-pago', label: 'Métodos de pago', icon: 'i-lucide-credit-card' },
        { to: '/cuenta/soporte', label: 'Mis consultas', icon: 'i-lucide-life-buoy' }
      ]
    : [])
]

const route = useRoute()
function isActive(link: (typeof links)[number]) {
  return link.exact ? route.path === link.to : route.path.startsWith(link.to)
}
const current = computed(() => links.find((link) => isActive(link)))

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
      <div class="flex flex-wrap items-center justify-between gap-3 pb-6">
        <!--
          Tira de identidad, no encabezado. El `h1` lo pone cada página, porque describe
          la pantalla —«Mis pedidos», «Direcciones»—; el nombre del cliente identifica
          la sesión y se repite igual en las siete. Antes esto era un `h1` y las páginas
          añadían el suyo: dos `h1` por pantalla, que para un lector de pantalla son dos
          títulos de documento en conflicto.
        -->
        <div class="min-w-0">
          <p class="text-sm text-[var(--text-muted)]">Área de cliente</p>
          <p class="truncate text-2xl font-bold text-[var(--text-strong)] sm:text-[1.75rem]">{{ user?.name }}</p>
          <p class="mt-0.5 truncate text-sm text-[var(--text-muted)]">
            {{ user?.email }}<template v-if="user?.company"> · {{ user.company }}</template>
          </p>
        </div>
        <UButton color="neutral" variant="outline" icon="i-lucide-log-out" @click="logout"> Cerrar sesión </UButton>
      </div>

      <div class="gap-8 lg:flex">
        <!-- Escritorio: navegación lateral persistente -->
        <nav aria-label="Secciones de la cuenta" class="hidden w-56 shrink-0 lg:block">
          <ul class="sticky top-6 space-y-0.5">
            <li v-for="link in links" :key="link.to">
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

        <!-- Móvil: tiras horizontales ocultan destinos. Un desplegable los enseña todos. -->
        <div class="mb-5 lg:hidden">
          <USelectMenu
            :model-value="current"
            :items="links"
            label-key="label"
            class="w-full"
            @update:model-value="(link) => link && navigateTo(link.to)"
          >
            <template #leading>
              <UIcon :name="current?.icon ?? 'i-lucide-menu'" class="size-4" />
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
