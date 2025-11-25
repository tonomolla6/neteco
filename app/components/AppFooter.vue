<script setup lang="ts">
const currentYear = new Date().getFullYear()
</script>

<template>
  <footer class="bg-white py-12 border-t border-slate-200 text-center text-slate-500 text-sm">
    <div class="container mx-auto px-6">
      <div class="flex flex-col md:flex-row justify-center items-center gap-2 mb-8">
        <span class="font-bold text-slate-700 text-lg">NETECO</span>
        <span class="hidden md:block text-slate-300">&bull;</span>
        <span>Suministros Integrales en Ontinyent</span>
      </div>

      <div class="flex flex-wrap justify-center gap-8 mb-8">
        <NuxtLink to="/legal" class="hover:text-sky-600 transition font-medium">Aviso Legal</NuxtLink>
        <NuxtLink to="/cookies" class="hover:text-sky-600 transition font-medium">Política de Cookies</NuxtLink>
      </div>

      <p class="text-slate-400">&copy; {{ currentYear }} Maria Carmen González Nacher. Todos los derechos reservados.</p>
    </div>
  </footer>
</template>
