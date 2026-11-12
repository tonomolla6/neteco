<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'
import type { HomeImage } from '~/utils/homeImages'

/**
 * «Compra por familias»: ocho tarjetas grandes con imagen, una por categoría.
 *
 * El comprador reconoce antes una foto de vasos o de garrafas que un nombre de familia.
 * La portada decide qué categorías salen y con qué imagen (`photo`, o la foto de un
 * producto real en `sample`), y garantiza que ninguna imagen se repite entre tarjetas.
 * Solo se enseñan categorías con producto: una tarjeta que lleva a una página vacía resta.
 */
export interface HomeFamilyTile {
  id: number
  name: string
  slug: string
  count: number
  /** Fotografía de ambiente de la categoría, si la hay. */
  photo: HomeImage | null
  /** Producto de la familia cuya foto se usa si no hay fotografía propia. */
  sample: Pick<ProductCardData, 'image' | 'name' | 'visual'> | null
}

defineProps<{ families: HomeFamilyTile[] }>()
</script>

<template>
  <section
    v-if="families.length"
    aria-labelledby="home-families"
    class="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8"
  >
    <div class="mb-4 flex items-end justify-between gap-3">
      <h2 id="home-families" class="text-xl font-bold text-[var(--text-strong)] sm:text-2xl">Compra por familias</h2>
      <NuxtLink to="/catalogo" class="text-sm font-semibold text-[var(--link)] underline-offset-4 hover:underline">
        Ver todo el catálogo
      </NuxtLink>
    </div>
    <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
      <li v-for="family in families" :key="family.id">
        <NuxtLink
          :to="`/categoria/${family.slug}`"
          data-home-family
          class="group flex h-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] transition hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-overlay)]"
        >
          <div class="relative aspect-[4/3] overflow-hidden bg-[var(--canvas)]">
            <img
              v-if="family.photo"
              :src="family.photo.src"
              alt=""
              :width="family.photo.width"
              :height="family.photo.height"
              loading="lazy"
              class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
            />
            <div
              v-else-if="family.sample"
              class="flex h-full items-center justify-center bg-white p-3 transition-transform duration-500 group-hover:scale-[1.04]"
            >
              <div class="aspect-square h-full">
                <ProductImage
                  :product="{ ...family.sample, imageAlt: '' }"
                  bare
                  sizes="(min-width: 1024px) 240px, 40vw"
                />
              </div>
            </div>
            <div v-else class="flex h-full items-center justify-center">
              <UIcon name="i-lucide-package" class="size-12 text-[var(--text-muted)]" aria-hidden="true" />
            </div>
          </div>
          <div class="flex flex-1 items-start justify-between gap-2 p-3 sm:p-4">
            <div class="min-w-0">
              <p
                class="font-display text-[15px] font-bold leading-snug text-[var(--text-strong)] group-hover:text-[var(--link)] sm:text-[17px]"
              >
                {{ family.name }}
              </p>
              <p class="mt-0.5 text-[13px] text-[var(--text-muted)]">
                {{ family.count }} producto{{ family.count === 1 ? '' : 's' }}
              </p>
            </div>
            <UIcon
              name="i-lucide-arrow-right"
              class="mt-1 hidden size-4 shrink-0 text-[var(--text-muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--link)] sm:block"
              aria-hidden="true"
            />
          </div>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>
