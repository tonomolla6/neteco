<script setup lang="ts">
/**
 * Franja de confianza con caras: quién reparte, quién atiende y en qué condiciones.
 *
 * Cada garantía sale de las condiciones comerciales configuradas (`useCommercialTerms`):
 * si el negocio no ha fijado un dato, la frase no lo inventa. Las fotografías son las del
 * encargo de imágenes; sin ellas, el bloque se compone con la superficie de marca.
 */
const { promises, parcel, terms } = useCommercialTerms()

const mainPhoto = computed(() => homeImage('equipo-reparto') ?? homeImage('hero-reparto-bar'))
const sidePhoto = computed(() => homeImage('equipo-atencion-telefonica'))

const intro = computed(() =>
  [
    terms.value.foundedYear
      ? `Somos de Ontinyent y servimos a negocios de la zona desde ${terms.value.foundedYear}.`
      : 'Somos de Ontinyent.',
    "Repartimos nosotros mismos en la Vall d'Albaida",
    parcel.value ? 'y enviamos por agencia al resto de la península.' : 'y te atendemos por teléfono y correo.'
  ].join(' ')
)
</script>

<template>
  <section aria-labelledby="home-trust" class="mx-auto max-w-[1440px] px-4 py-8 sm:px-6 sm:py-10">
    <div
      class="grid overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] lg:grid-cols-[5fr_6fr]"
    >
      <!-- Fotografías -->
      <div class="relative min-h-56 bg-neteco-900 sm:min-h-72">
        <img
          v-if="mainPhoto"
          :src="mainPhoto.src"
          :alt="mainPhoto.alt"
          :width="mainPhoto.width"
          :height="mainPhoto.height"
          loading="lazy"
          class="absolute inset-0 h-full w-full object-cover"
        />
        <div v-else class="flex h-full flex-col items-start justify-end gap-3 p-6 text-white sm:p-8">
          <UIcon name="i-lucide-truck" class="size-12 text-neteco-200" aria-hidden="true" />
          <p class="font-display text-2xl font-bold leading-tight text-white sm:text-3xl">
            Reparto propio en Ontinyent y la Vall d'Albaida
          </p>
        </div>
        <img
          v-if="mainPhoto && sidePhoto"
          :src="sidePhoto.src"
          :alt="sidePhoto.alt"
          :width="sidePhoto.width"
          :height="sidePhoto.height"
          loading="lazy"
          class="absolute bottom-4 right-4 hidden aspect-[3/2] w-44 rounded-[var(--radius-surface)] border-4 border-white object-cover shadow-[var(--shadow-overlay)] sm:block lg:w-52"
        />
      </div>

      <!-- Garantías -->
      <div class="p-5 sm:p-8">
        <h2 id="home-trust" class="text-xl font-bold text-[var(--text-strong)] sm:text-2xl">Un proveedor de aquí</h2>
        <p class="mt-2 text-[15px] text-[var(--text)] sm:text-base">{{ intro }}</p>
        <ul data-commercial-promises class="mt-6 grid gap-x-6 gap-y-5 sm:grid-cols-2">
          <li v-for="promise in promises" :key="promise.key">
            <NuxtLink
              :to="promise.to"
              class="group flex items-start gap-3 rounded-[var(--radius-control)] focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <span class="grid size-11 shrink-0 place-items-center rounded-full bg-neteco-50 text-neteco-700">
                <UIcon :name="promise.icon" class="size-5" aria-hidden="true" />
              </span>
              <span class="min-w-0">
                <span class="block font-semibold text-[var(--text-strong)] group-hover:text-[var(--link)]">
                  {{ promise.title }}
                </span>
                <span class="block text-sm text-[var(--text-muted)]">{{ promise.text }}</span>
              </span>
            </NuxtLink>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
