<script setup lang="ts">
/**
 * Shell único del área de cliente.
 *
 * La portada (`/cuenta`) es un índice de bloques clicables, como «Mi cuenta» de Amazon: no
 * lleva navegación lateral porque ella misma es el menú. El resto de páginas comparten el
 * mismo ancho, las mismas migas, la misma cabecera y la misma columna lateral agrupada.
 *
 * Los paneles heredados que pintaban HTML sin estilo (botones, campos y listas desnudos) se
 * normalizan aquí, en `.account-main`, para que todas las pantallas parezcan la misma tienda.
 */
const { user, clear, loggedIn } = useUserSession()
const runtime = useRuntimeConfig()
const route = useRoute()

const groups = computed(() => accountSectionGroups(runtime.public.serverRuntime === 'cloudflare'))
const isHub = computed(() => route.path.replace(/\/+$/, '') === '/cuenta')

/** Pantallas de la cuenta que no tienen bloque propio en la portada. */
const EXTRA_TITLES: Record<string, string> = {
  '/cuenta/centro-preferencias': 'Centro de preferencias',
  '/cuenta/documentos-empresa': 'Documentos de empresa',
  '/cuenta/referidos': 'Programa de referidos',
  '/cuenta/invitacion': 'Invitación'
}
const current = computed(() => accountSectionFor(route.path))
const currentLabel = computed(() => current.value?.label ?? EXTRA_TITLES[route.path.replace(/\/+$/, '')] ?? '')

function isActive(to: string) {
  return route.path === to || route.path.startsWith(`${to}/`)
}

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

    <div class="account-shell mx-auto w-full max-w-[1200px] flex-1 px-4 pb-12 pt-4 sm:px-6 sm:pt-6">
      <!-- Migas: el mismo rastro en todas las páginas de la cuenta -->
      <nav
        aria-label="Estás en"
        data-account-breadcrumb
        class="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 pb-3 text-sm"
      >
        <template v-if="isHub">
          <span class="font-semibold text-[var(--text-strong)]">Mi cuenta</span>
        </template>
        <template v-else>
          <NuxtLink
            to="/cuenta"
            class="inline-flex min-h-9 items-center gap-1 font-medium text-[var(--link)] hover:underline"
          >
            <UIcon name="i-lucide-chevron-left" class="size-4 lg:hidden" />
            Mi cuenta
          </NuxtLink>
          <UIcon name="i-lucide-chevron-right" class="size-3.5 text-[var(--text-muted)]" />
          <span class="font-semibold text-[var(--text-strong)]" aria-current="page">{{ currentLabel }}</span>
        </template>
        <span
          data-account-identity
          class="ml-auto hidden min-w-0 truncate text-[13px] text-[var(--text-muted)] sm:block"
        >
          {{ user?.company || user?.name }} · {{ user?.email }}
        </span>
      </nav>

      <div :class="isHub ? '' : 'gap-8 lg:flex'">
        <!-- Escritorio: navegación lateral agrupada, igual en todas las páginas interiores -->
        <nav v-if="!isHub && loggedIn" aria-label="Secciones de la cuenta" class="hidden w-60 shrink-0 lg:block">
          <div class="sticky top-6 space-y-5">
            <div v-for="group in groups" :key="group.title">
              <p class="px-3 pb-1.5 text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
                {{ group.title }}
              </p>
              <ul class="space-y-0.5">
                <li v-for="link in group.sections.filter((section) => !section.hubOnly)" :key="link.to">
                  <NuxtLink
                    :to="link.to"
                    class="flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors"
                    :class="
                      isActive(link.to)
                        ? 'bg-neteco-50 text-neteco-800'
                        : 'text-[var(--text)] hover:bg-[var(--surface-sunken)]'
                    "
                    :aria-current="isActive(link.to) ? 'page' : undefined"
                  >
                    <UIcon :name="link.icon" class="size-4 shrink-0" />
                    {{ link.label }}
                  </NuxtLink>
                </li>
              </ul>
            </div>
            <div class="border-t border-[var(--border)] pt-3">
              <button
                type="button"
                data-account-logout
                class="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-left text-sm font-medium text-[var(--text)] hover:bg-[var(--surface-sunken)]"
                @click="logout"
              >
                <UIcon name="i-lucide-log-out" class="size-4 shrink-0" />
                Cerrar sesión
              </button>
            </div>
          </div>
        </nav>

        <main id="contenido-principal" class="account-main min-w-0 flex-1" tabindex="-1">
          <slot />
        </main>
      </div>

      <div
        v-if="loggedIn"
        class="mt-10 flex justify-center border-t border-[var(--border)] pt-5"
        :class="isHub ? '' : 'lg:hidden'"
      >
        <UButton color="neutral" variant="outline" icon="i-lucide-log-out" @click="logout">Cerrar sesión</UButton>
      </div>
    </div>

    <!-- La misma barra inferior del resto de la tienda: en móvil, «Cuenta» vuelve a la portada -->
    <AppFooter class="mb-14 lg:mb-0" />
    <AppBottomBar />
    <ConsentManager />
  </div>
</template>

<style>
/*
 * Normalización del área de cliente.
 *
 * Varios paneles de la cuenta se escribieron con HTML desnudo (botones, campos, listas y
 * títulos sin clases). En lugar de dejar cada uno con un aspecto distinto, aquí reciben el
 * mismo tratamiento que los componentes del sistema. Todo va en `:where()` para que cualquier
 * clase utilitaria puesta a propósito siga mandando, y se excluye lo que ya pinta Nuxt UI
 * (`data-slot`) o lleva estilo propio.
 */
.account-main {
  font-size: 0.9375rem;
  line-height: 1.55;
}

/* Títulos: una sola escala en todas las pantallas */
.account-main :where(h1) {
  font-size: 1.75rem;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text-strong);
}
.account-main :where(h2:not([data-slot])) {
  font-size: 1.125rem;
  line-height: 1.35;
  font-weight: 700;
  color: var(--text-strong);
}
.account-main :where(h3:not([data-slot])) {
  font-size: 0.9375rem;
  line-height: 1.4;
  font-weight: 600;
  color: var(--text-strong);
}
@media (max-width: 639px) {
  .account-main :where(h1) {
    font-size: 1.5rem;
  }
}

/* Tarjeta estándar para paneles heredados */
.account-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  background: var(--surface);
  padding: 1.25rem;
}
@media (min-width: 640px) {
  .account-card {
    padding: 1.5rem;
  }
}
.account-card > :where(section, div, form, main):not([class]) > * + *,
.account-main :where(section:not([class]), form:not([class]), fieldset:not([class])) > * + * {
  margin-top: 0.75rem;
}

/* Panel incrustado bajo la cabecera de página: su propio título sobra y su marco también */
.account-embedded :where(h1) {
  display: none;
}
.account-embedded > :where(section) {
  border: 0;
  border-radius: 0;
  padding: 0;
}
.account-embedded > :where(section) > :where(h2:first-child) {
  display: none;
}

/* Botones desnudos → botón secundario del sistema */
.account-main
  :where(
    button:not([data-slot]):not([role='tab']):not([role='radio']):not([role='switch']):not([role='checkbox']):not(
        [class*='bg-']
      ):not([class*='flex']):not([class*='grid']):not([class*='size-']):not([class*='w-full'])
  ) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  min-height: 2.5rem;
  padding: 0.5rem 0.875rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--text-strong);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  transition:
    background-color 0.15s,
    border-color 0.15s;
  margin-right: 0.5rem;
}
.account-main
  :where(
    button:not([data-slot]):not([role='tab']):not([role='radio']):not([role='switch']):not([role='checkbox']):not(
        [class*='bg-']
      ):not([class*='flex']):not([class*='grid']):not([class*='size-']):not([class*='w-full'])
  ):hover:not(:disabled) {
  background: var(--surface-sunken);
}
.account-main button.underline:not([data-slot]) {
  text-decoration: none;
}
/* El envío de un formulario es la acción principal */
.account-main
  :where(
    button[type='submit']:not([data-slot]):not([class*='bg-']):not([class*='flex']):not([class*='grid']):not(
        [class*='size-']
      ):not([class*='w-full'])
  ) {
  border-color: var(--action);
  background: var(--action);
  color: #fff;
}
.account-main
  :where(
    button[type='submit']:not([data-slot]):not([class*='bg-']):not([class*='flex']):not([class*='grid']):not(
        [class*='size-']
      ):not([class*='w-full'])
  ):hover:not(:disabled) {
  background: var(--action-hover);
}
.account-main :where(button:not([data-slot])):disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.account-main :where(button:not([data-slot])):focus-visible {
  outline: 2px solid var(--action);
  outline-offset: 2px;
}

/* Campos desnudos */
.account-main
  :where(
    input:not([data-slot]):not([type='checkbox']):not([type='radio']):not([type='file']):not([type='hidden']):not(
        [class*='bg-']
      ),
    select:not([data-slot]):not([class*='bg-']),
    textarea:not([data-slot]):not([class*='bg-'])
  ) {
  display: block;
  width: 100%;
  max-width: 32rem;
  min-height: 2.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--text-strong);
  font-size: 0.9375rem;
  line-height: 1.4;
}
.account-main :where(textarea:not([data-slot])) {
  min-height: 6rem;
  max-width: 40rem;
}
.account-main :where(input[type='time']:not([data-slot]), input[type='date']:not([data-slot])) {
  width: auto;
  min-width: 9rem;
}
.account-main :where(input:not([data-slot]), select:not([data-slot]), textarea:not([data-slot])):focus-visible {
  outline: 2px solid var(--action);
  outline-offset: 1px;
  border-color: var(--action);
}
.account-main :where(input[type='checkbox']:not([data-slot]), input[type='radio']:not([data-slot])) {
  width: 1.125rem;
  height: 1.125rem;
  flex-shrink: 0;
  margin-right: 0.5rem;
  vertical-align: -0.2em;
  accent-color: var(--action);
}
.account-main :where(label:not([data-slot]):not([class])) {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-strong);
}
.account-main :where(label:not([data-slot]):not([class])) > :where(input, select, textarea) {
  margin-top: 0.375rem;
}
.account-main :where(label:not([data-slot]):not([class])) > :where(input[type='checkbox'], input[type='radio']) {
  margin-top: 0;
}
.account-main :where(fieldset:not([data-slot])) {
  min-width: 0;
}
.account-main :where(legend:not([class])) {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-strong);
  padding-bottom: 0.375rem;
}

/* Mensajes de estado y error de los paneles heredados */
.account-main :where(p[role='alert']:not([class]), div[role='alert']:not([class])) {
  border: 1px solid var(--color-red-200);
  border-radius: var(--radius-control);
  background: var(--color-red-50);
  color: var(--color-red-800);
  padding: 0.625rem 0.875rem;
  font-size: 0.875rem;
}
.account-main :where(p[role='status']:not([class])) {
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
  color: var(--text);
  padding: 0.625rem 0.875rem;
  font-size: 0.875rem;
}

/* Enlaces y listas sin clase */
.account-main
  :where(
    a:not([class]):not([data-slot]),
    a[class='underline'],
    p > a:not([data-slot]):not([class*='hover:underline'])
  ) {
  color: var(--link);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.account-main :where(ul:not([class]):not([data-slot])) > :where(li) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  padding: 0.75rem 0;
  border-top: 1px solid var(--border);
}
.account-main :where(ul:not([class]):not([data-slot])) > :where(li:first-child) {
  border-top: 0;
}
.account-main :where(table:not([class])) {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.account-main :where(table:not([class])) :where(th, td) {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
</style>
