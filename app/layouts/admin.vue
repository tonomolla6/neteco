<script setup lang="ts">
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import AdminCommandPalette from '~/components/AdminCommandPalette.vue'
import AdminNavigationContext from '~/components/AdminNavigationContext.vue'
import AdminRecentActivity from '~/components/AdminRecentActivity.vue'
import AdminGlobalSearch from '~/components/AdminGlobalSearch.vue'
const { user, session, clear } = useUserSession()
const route = useRoute()
const runtime = useRuntimeConfig()
const navigation = useAdminNavigation()

const legacyGroups = [
  {
    label: 'Operación',
    links: [
      { to: '/admin', label: 'Hoy', icon: 'i-lucide-layout-dashboard', exact: true },
      { to: '/admin/pedidos', label: 'Pedidos', icon: 'i-lucide-receipt-text' },
      { to: '/admin/devoluciones', label: 'Devoluciones', icon: 'i-lucide-rotate-ccw' },
      { to: '/admin/soporte', label: 'Soporte', icon: 'i-lucide-life-buoy' },
      { to: '/admin/clientes', label: 'Clientes', icon: 'i-lucide-building-2' }
    ]
  },
  {
    label: 'Catálogo',
    links: [
      { to: '/admin/productos', label: 'Productos', icon: 'i-lucide-package' },
      { to: '/admin/categorias', label: 'Familias', icon: 'i-lucide-folder-tree' },
      ...(runtime.public.serverRuntime === 'cloudflare'
        ? [{ to: '/admin/politicas-catalogo', label: 'Políticas de publicación', icon: 'i-lucide-shield-check' }]
        : []),
      { to: '/admin/precios', label: 'Precios', icon: 'i-lucide-badge-euro' },
      { to: '/admin/medios', label: 'Medios', icon: 'i-lucide-images' },
      { to: '/admin/contenido', label: 'Contenido', icon: 'i-lucide-panels-top-left' }
    ]
  },
  {
    label: 'Marketing',
    links:
      runtime.public.serverRuntime === 'cloudflare'
        ? [
            { to: '/admin/newsletter', label: 'Newsletter editorial', icon: 'i-lucide-mails' },
            { to: '/admin/analitica', label: 'Analítica', icon: 'i-lucide-chart-no-axes-combined' }
          ]
        : []
  },
  {
    label: 'Sistema',
    links: [
      { to: '/admin/operaciones', label: 'Operaciones y colas', icon: 'i-lucide-activity' },
      { to: '/admin/busqueda', label: 'Relevancia de búsqueda', icon: 'i-lucide-search-check' },
      { to: '/admin/flags', label: 'Feature flags', icon: 'i-lucide-toggle-right' }
    ]
  }
].filter((group) => group.links.length > 0)

const groups = computed(() => (navigation.cloudflare.value ? navigation.groups.value : legacyGroups))
const allLinks = computed(() => groups.value.flatMap((group) => group.links))

function isActive(link: { to: string; exact?: boolean }) {
  return route.path === link.to || (!link.exact && route.path.startsWith(link.to + '/'))
}
const current = computed(() => allLinks.value.find((link) => isActive(link)))
const contextScope = computed(() =>
  JSON.stringify([user.value?.id, session.value?.sessionId, session.value?.sessionVersion])
)

const mobileOpen = ref(false)
watch(
  () => route.fullPath,
  () => (mobileOpen.value = false)
)

// D1 administrative endpoints require MFA even during local development.
const mfaEnforced = true

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  // Navegación dura: si no, el middleware `admin` redirige antes de llegar a la home.
  await navigateTo('/', { replace: true, external: true })
}
</script>

<template>
  <div class="min-h-screen bg-[var(--canvas)]">
    <SupportImpersonationBanner v-if="runtime.public.serverRuntime === 'cloudflare'" />
    <a
      href="#panel-principal"
      class="fixed left-3 top-3 z-[100] -translate-y-20 rounded-[var(--radius-control)] bg-slate-950 px-4 py-2 font-semibold text-white shadow-lg transition focus:translate-y-0"
    >
      Saltar al contenido
    </a>

    <header class="sticky top-0 z-40 border-b border-slate-800 bg-slate-900 text-white">
      <div class="flex h-14 items-center gap-3 px-4">
        <UButton
          class="lg:hidden"
          color="neutral"
          variant="ghost"
          :icon="mobileOpen ? 'i-lucide-x' : 'i-lucide-menu'"
          :aria-expanded="mobileOpen"
          aria-controls="admin-nav"
          aria-label="Abrir la navegación del panel"
          @click="mobileOpen = !mobileOpen"
        />

        <NuxtLink to="/admin" class="flex shrink-0 items-center gap-2">
          <img src="/logo-figura.png" alt="" width="26" height="28" class="h-7 w-auto" />
          <span class="font-display font-bold">NETECO</span>
          <span class="rounded bg-neteco-700 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider">
            Panel
          </span>
        </NuxtLink>

        <div class="ml-auto flex shrink-0 items-center gap-1 text-sm">
          <AdminCommandPalette
            :groups="groups"
            :enabled="
              !navigation.cloudflare.value ||
              (navigation.status.value === 'ready' && navigation.capabilities.value?.state === 'ready')
            "
          />
          <span class="hidden max-w-[16rem] truncate px-2 text-slate-300 sm:block">{{ user?.name }}</span>
          <UButton to="/" color="neutral" variant="ghost" icon="i-lucide-store" class="text-slate-300">
            <span class="hidden sm:inline">Ver tienda</span>
          </UButton>
          <UButton color="neutral" variant="ghost" icon="i-lucide-log-out" class="text-slate-300" @click="logout">
            <span class="hidden sm:inline">Salir</span>
          </UButton>
        </div>
      </div>
    </header>

    <div class="lg:flex">
      <!-- Navegación agrupada. En escritorio es una columna persistente; en móvil,
           un panel desplegable que enseña los trece destinos a la vez. -->
      <nav
        id="admin-nav"
        aria-label="Secciones del panel"
        class="border-b border-[var(--border)] bg-[var(--surface)] lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:w-60 lg:shrink-0 lg:overflow-y-auto lg:border-b-0 lg:border-r"
        :class="mobileOpen ? 'block' : 'hidden lg:block'"
      >
        <div class="space-y-5 p-3">
          <div v-for="group in groups" :key="group.label">
            <p class="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {{ group.label }}
            </p>
            <ul class="space-y-0.5">
              <li v-for="link in group.links" :key="link.to">
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
          </div>
        </div>
      </nav>

      <main id="panel-principal" class="min-w-0 max-w-full flex-1 overflow-x-clip px-4 py-6" tabindex="-1">
        <!-- El panel deja entrar con el rol, pero la API exige MFA. Sin este aviso el
             administrador solo veía errores rojos sin causa en cada pantalla. -->
        <UAlert
          v-if="
            navigation.cloudflare.value
              ? navigation.capabilities.value?.state === 'mfa_required'
              : mfaEnforced && !user?.mfaVerified
          "
          class="mb-6"
          role="alert"
          color="warning"
          variant="subtle"
          icon="i-lucide-shield-alert"
          title="Activa la verificación en dos pasos para gestionar la tienda"
          description="El panel requiere un segundo factor. Hasta que la actives, las pantallas no podrán cargar datos."
        >
          <template #actions>
            <UButton size="sm" color="warning" to="/cuenta/seguridad">Activar ahora</UButton>
          </template>
        </UAlert>

        <div v-if="navigation.cloudflare.value" class="mb-4" aria-live="polite">
          <p v-if="navigation.status.value === 'loading' || navigation.status.value === 'idle'">
            Comprobando permisos de la sesión…
          </p>
          <p v-else-if="navigation.status.value === 'error'" role="alert">
            No se han podido comprobar los permisos. No se muestran datos ni enlaces anteriores.
          </p>
          <p v-else-if="navigation.status.value === 'unauthenticated'" role="alert">
            La sesión ha caducado.
            <NuxtLink :to="`/login?redirect=${encodeURIComponent(route.fullPath)}`">Vuelve a iniciar sesión</NuxtLink>.
          </p>
          <p v-else-if="navigation.capabilities.value?.state === 'email_unverified'" role="alert">
            Verifica tu correo para acceder al panel.
          </p>
          <p v-else-if="navigation.capabilities.value?.state === 'forbidden'" role="status">
            La sesión no tiene permisos para gestionar la tienda.
          </p>
          <p
            v-else-if="navigation.capabilities.value?.state === 'ready' && !navigation.routeAllowed.value"
            role="alert"
          >
            No tienes acceso a esta sección. Elige una sección disponible.
          </p>
          <UButton
            data-admin-permissions-refresh
            size="sm"
            variant="outline"
            :disabled="navigation.status.value === 'loading'"
            @click="navigation.refresh()"
            >Volver a comprobar permisos</UButton
          >
        </div>

        <AdminNavigationContext
          :groups="groups"
          :path="route.path"
          :scope-key="contextScope"
          :pending="
            navigation.cloudflare.value && (navigation.status.value === 'loading' || navigation.status.value === 'idle')
          "
          :enabled="
            !navigation.cloudflare.value ||
            (navigation.status.value === 'ready' && navigation.capabilities.value?.state === 'ready')
          "
        />
        <AdminGlobalSearch
          v-if="navigation.cloudflare.value"
          class="my-5 rounded-xl border border-slate-200 bg-white p-4"
          :groups="groups"
          :scope-key="contextScope"
          :pending="navigation.status.value === 'loading' || navigation.status.value === 'idle'"
          :enabled="navigation.status.value === 'ready' && navigation.capabilities.value?.state === 'ready'"
        />
        <details v-if="navigation.cloudflare.value" class="my-5 rounded-xl border border-slate-200 bg-white p-4">
          <summary class="cursor-pointer font-semibold text-slate-800">Actividad de la tienda</summary>
          <AdminRecentActivity
            class="mt-4"
            :scope-key="contextScope"
            :pending="navigation.status.value === 'loading' || navigation.status.value === 'idle'"
            :enabled="navigation.status.value === 'ready' && navigation.capabilities.value?.state === 'ready'"
          />
        </details>
        <p v-if="current" class="sr-only">Sección actual: {{ current.label }}</p>
        <slot v-if="!navigation.cloudflare.value || navigation.routeAllowed.value" />
      </main>
    </div>
  </div>
</template>
