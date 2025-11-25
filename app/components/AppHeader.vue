<script setup lang="ts">
import { Menu, X } from 'lucide-vue-next'

const isMenuOpen = ref(false)
const route = useRoute()

const toggleMenu = () => {
  isMenuOpen.value = !isMenuOpen.value
}

const closeMenu = () => {
  isMenuOpen.value = false
}

const isHome = computed(() => route.path === '/')
</script>

<template>
  <header class="sticky top-0 z-50 bg-white/90 backdrop-blur-md shadow-sm border-b border-slate-200">
    <div class="container mx-auto px-6 py-4 flex justify-between items-center">
      <!-- Logo -->
      <NuxtLink to="/" class="group" @click="closeMenu">
        <LogoNeteco size="sm" />
      </NuxtLink>

      <!-- Desktop Nav -->
      <nav class="hidden md:flex items-center gap-8 font-medium text-slate-600">
        <NuxtLink
          to="/"
          class="hover:text-primary transition"
          :class="{ 'text-primary font-bold': isHome }"
        >
          Inicio
        </NuxtLink>
        <template v-if="isHome">
          <a href="#empresa" class="hover:text-primary transition">La Empresa</a>
          <a href="#servicios" class="hover:text-primary transition">Sectores</a>
        </template>
        <a
          href="#contacto"
          class="bg-primary text-white px-6 py-2.5 rounded-xl hover:bg-primary-dark transition shadow-lg shadow-primary/20 font-semibold"
        >
          Contactar
        </a>
      </nav>

      <!-- Mobile Menu Button -->
      <button @click="toggleMenu" class="md:hidden text-slate-600">
        <X v-if="isMenuOpen" class="w-7 h-7" />
        <Menu v-else class="w-7 h-7" />
      </button>
    </div>

    <!-- Mobile Nav -->
    <div
      v-if="isMenuOpen"
      class="md:hidden bg-white border-t border-slate-100 absolute w-full left-0 py-6 px-6 shadow-xl flex flex-col gap-6 h-screen"
    >
      <NuxtLink to="/" class="text-lg text-slate-700 font-medium" @click="closeMenu">Inicio</NuxtLink>
      <a href="#empresa" class="text-lg text-slate-700" @click="closeMenu">La Empresa</a>
      <a href="#servicios" class="text-lg text-slate-700" @click="closeMenu">Sectores</a>
      <a href="#contacto" class="text-lg font-bold text-primary" @click="closeMenu">Contactar</a>
    </div>
  </header>
</template>
