<script setup lang="ts">
import '~/assets/css/admin.css'
import { adminNavigationLocate } from '~~/shared/admin-navigation'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import AdminCommandPalette from '~/components/AdminCommandPalette.vue'
import AdminRecentActivity from '~/components/AdminRecentActivity.vue'
import AdminGlobalSearch from '~/components/AdminGlobalSearch.vue'
const { user, session, clear } = useUserSession()
const route = useRoute()
const runtime = useRuntimeConfig()
const navigation = useAdminNavigation()

const cloudflare = computed(() => navigation.cloudflare.value)
const groups = computed(() =>
  cloudflare.value
    ? navigation.groups.value
    : navigation.tree.value.map((section) => ({
        label: section.label,
        links: section.items.flatMap((item) =>
          item.tabs.map(({ to, label, icon, exact }) => ({ to, label, icon, ...(exact ? { exact } : {}) }))
        )
      }))
)
const ready = computed(
  () => !cloudflare.value || (navigation.status.value === 'ready' && navigation.capabilities.value?.state === 'ready')
)
const checking = computed(
  () => cloudflare.value && (navigation.status.value === 'loading' || navigation.status.value === 'idle')
)
const located = computed(() => adminNavigationLocate(route.path, navigation.tree.value, route.fullPath))
const contextScope = computed(() =>
  JSON.stringify([user.value?.id, session.value?.sessionId, session.value?.sessionVersion])
)

/* Menú en acordeón: una sección abierta, la de la ruta actual; se recuerda la última
   que abrió la persona para cuando vuelve al panel desde una pantalla sin sección. */
const STORE = 'neteco-admin-nav-open'
const openSection = ref<string | null>(located.value?.section.id ?? null)
watch(
  () => located.value?.section.id,
  (id) => {
    if (id) openSection.value = id
  }
)
onMounted(() => {
  if (openSection.value) return
  try {
    openSection.value = localStorage.getItem(STORE)
  } catch {
    /* almacenamiento no disponible: el menú funciona igual */
  }
})
function toggle(id: string) {
  openSection.value = openSection.value === id ? null : id
  try {
    if (openSection.value) localStorage.setItem(STORE, openSection.value)
    else localStorage.removeItem(STORE)
  } catch {
    /* sin persistencia */
  }
}

const mobileOpen = ref(false)
const searchOpen = ref(false)
const activityOpen = ref(false)
watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false
    searchOpen.value = false
    activityOpen.value = false
  }
)

// D1 administrative endpoints require MFA even during local development.
const mfaEnforced = true
const needsMfa = computed(() =>
  cloudflare.value ? navigation.capabilities.value?.state === 'mfa_required' : mfaEnforced && !user.value?.mfaVerified
)
/** Solo hay aviso de permisos cuando algo falla; mientras se comprueba no se pinta nada suelto. */
const permissionIssue = computed(() => {
  if (!cloudflare.value || checking.value) return null
  const state = navigation.capabilities.value?.state
  if (navigation.status.value === 'error')
    return {
      title: 'No se han podido comprobar tus permisos',
      text: 'Por seguridad no se muestran datos hasta confirmarlos.',
      retry: true
    }
  if (navigation.status.value === 'unauthenticated')
    return { title: 'La sesión ha caducado', text: 'Vuelve a iniciar sesión para seguir trabajando.', login: true }
  if (state === 'email_unverified')
    return { title: 'Verifica tu correo para acceder al panel', text: 'Revisa tu bandeja de entrada.', retry: true }
  if (state === 'forbidden')
    return { title: 'Tu cuenta no tiene acceso al panel', text: 'Pide acceso a un administrador de la tienda.' }
  if (state === 'ready' && !navigation.routeAllowed.value)
    return { title: 'No tienes acceso a esta sección', text: 'Elige otra sección del menú.', retry: true }
  return null
})

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  // Navegación dura: si no, el middleware `admin` redirige antes de llegar a la home.
  await navigateTo('/', { replace: true, external: true })
}
</script>

<template>
  <div class="adm min-h-screen bg-[var(--canvas)]">
    <SupportImpersonationBanner v-if="runtime.public.serverRuntime === 'cloudflare'" />
    <a
      href="#panel-principal"
      class="fixed left-3 top-3 z-[100] -translate-y-20 rounded-[var(--radius-control)] bg-slate-950 px-4 py-2 font-semibold text-white shadow-lg transition focus:translate-y-0"
    >
      Saltar al contenido
    </a>

    <header class="sticky top-0 z-40 border-b border-slate-800 bg-slate-900 text-white">
      <div class="flex h-14 items-center gap-2 px-3 sm:px-4">
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

        <NuxtLink to="/admin" class="flex shrink-0 items-center gap-2 lg:w-56">
          <img src="/logo-figura.svg" alt="" width="26" height="28" class="h-7 w-auto" />
          <span class="font-display text-base font-bold">NETECO</span>
          <span class="hidden rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-semibold text-slate-200 sm:inline">
            Panel
          </span>
        </NuxtLink>

        <div class="min-w-0 flex-1 text-slate-200">
          <AdminCommandPalette :groups="groups" :enabled="ready" />
        </div>

        <div class="flex shrink-0 items-center gap-0.5 text-sm">
          <UButton
            v-if="cloudflare"
            color="neutral"
            variant="ghost"
            icon="i-lucide-search"
            class="text-slate-300"
            aria-label="Buscar productos y pedidos"
            title="Buscar productos y pedidos"
            :disabled="!ready"
            @click="searchOpen = true"
          />
          <UButton
            v-if="cloudflare"
            color="neutral"
            variant="ghost"
            icon="i-lucide-history"
            class="text-slate-300"
            aria-label="Actividad reciente"
            title="Actividad reciente"
            :disabled="!ready"
            @click="activityOpen = true"
          />
          <UButton
            to="/"
            color="neutral"
            variant="ghost"
            icon="i-lucide-store"
            class="text-slate-300"
            title="Ver la tienda"
          >
            <span class="hidden xl:inline">Ver tienda</span>
          </UButton>
          <span class="mx-1 hidden h-6 w-px bg-white/15 md:block" />
          <span class="hidden max-w-[14rem] truncate px-1 text-slate-300 md:block">{{ user?.name }}</span>
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-log-out"
            class="text-slate-300"
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
            @click="logout"
          />
        </div>
      </div>
    </header>

    <div class="lg:flex">
      <nav
        id="admin-nav"
        aria-label="Secciones del panel"
        class="border-b border-[var(--border)] bg-[var(--surface)] lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:w-60 lg:shrink-0 lg:overflow-y-auto lg:border-b-0 lg:border-r"
        :class="mobileOpen ? 'block' : 'hidden lg:block'"
      >
        <div v-if="checking && !navigation.tree.value.length" class="space-y-2 p-3" aria-hidden="true">
          <div v-for="row in 8" :key="row" class="h-8 animate-pulse rounded bg-[var(--surface-sunken)]" />
        </div>
        <ul v-else class="space-y-0.5 p-2.5">
          <li v-for="section in navigation.tree.value" :key="section.id">
            <NuxtLink
              v-if="section.items.length === 1"
              :to="section.items[0]!.tabs[0]!.to"
              class="adm-nav__section"
              :aria-current="located?.section.id === section.id ? 'page' : undefined"
            >
              <UIcon :name="section.icon" class="size-[1.125rem] shrink-0" />
              {{ section.label }}
            </NuxtLink>
            <template v-else>
              <button
                type="button"
                class="adm-nav__section"
                :aria-expanded="openSection === section.id"
                :aria-controls="`admin-nav-${section.id}`"
                :data-current="located?.section.id === section.id"
                @click="toggle(section.id)"
              >
                <UIcon :name="section.icon" class="size-[1.125rem] shrink-0" />
                <span class="flex-1">{{ section.label }}</span>
                <UIcon
                  name="i-lucide-chevron-down"
                  class="size-4 shrink-0 text-[var(--text-muted)] transition-transform"
                  :class="openSection === section.id && 'rotate-180'"
                />
              </button>
              <ul v-show="openSection === section.id" :id="`admin-nav-${section.id}`" class="space-y-0.5 py-0.5">
                <li v-for="item in section.items" :key="item.label">
                  <NuxtLink
                    :to="item.tabs[0]!.to"
                    class="adm-nav__item"
                    :aria-current="located?.item === item ? 'page' : undefined"
                  >
                    {{ item.label }}
                  </NuxtLink>
                </li>
              </ul>
            </template>
          </li>
        </ul>
      </nav>

      <main
        id="panel-principal"
        class="min-w-0 max-w-full flex-1 overflow-x-clip px-[var(--adm-gutter)] py-6"
        tabindex="-1"
      >
        <!-- El panel deja entrar con el rol, pero la API exige MFA. Sin este aviso el
             administrador solo veía errores rojos sin causa en cada pantalla. -->
        <UAlert
          v-if="needsMfa"
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

        <div aria-live="polite">
          <p v-if="checking" class="sr-only">Comprobando permisos de la sesión…</p>
          <UAlert
            v-else-if="permissionIssue"
            class="mb-6"
            role="alert"
            color="warning"
            variant="subtle"
            icon="i-lucide-lock"
            :title="permissionIssue.title"
            :description="permissionIssue.text"
          >
            <template #actions>
              <UButton
                v-if="permissionIssue.login"
                size="sm"
                color="warning"
                :to="`/login?redirect=${encodeURIComponent(route.fullPath)}`"
              >
                Iniciar sesión
              </UButton>
              <UButton
                v-else-if="permissionIssue.retry"
                data-admin-permissions-refresh
                size="sm"
                color="warning"
                variant="outline"
                @click="navigation.refresh()"
              >
                Reintentar
              </UButton>
            </template>
          </UAlert>
        </div>

        <div v-if="checking && !navigation.routeAllowed.value" class="space-y-4" aria-hidden="true">
          <div class="h-8 w-56 animate-pulse rounded bg-[var(--surface-sunken)]" />
          <div class="h-40 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]" />
        </div>
        <slot v-if="!cloudflare || navigation.routeAllowed.value" />
      </main>
    </div>

    <UModal
      v-if="cloudflare"
      v-model:open="searchOpen"
      title="Buscar productos y pedidos"
      description="Por nombre, referencia o número de pedido."
    >
      <template #body>
        <div class="adm adm-body adm-global-search">
          <AdminGlobalSearch :groups="groups" :scope-key="contextScope" :pending="checking" :enabled="ready" />
        </div>
      </template>
    </UModal>
    <USlideover
      v-if="cloudflare"
      v-model:open="activityOpen"
      title="Actividad reciente"
      description="Últimos cambios registrados en la tienda."
    >
      <template #body>
        <div class="adm adm-body adm-global-search">
          <AdminRecentActivity :scope-key="contextScope" :pending="checking" :enabled="ready" />
        </div>
      </template>
    </USlideover>
  </div>
</template>
