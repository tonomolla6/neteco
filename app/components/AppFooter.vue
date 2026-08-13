<script setup lang="ts">
const year = new Date().getFullYear()
const runtime = useRuntimeConfig()
const isProduction = runtime.public.appEnv === 'production'

function configureCookies() {
  window.dispatchEvent(new Event('neteco-open-consent'))
}
</script>

<template>
  <footer class="mt-16 bg-neteco-950 text-slate-300">
    <div class="mx-auto grid max-w-[1600px] gap-10 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <div class="flex items-center gap-2">
          <img src="/logo-figura.png" alt="" class="h-9 w-auto" />
          <span class="text-lg font-bold text-white">NETECO</span>
        </div>
        <p class="mt-3 text-sm leading-relaxed text-slate-400">
          Más de 25 años suministrando higiene, limpieza y equipamiento a empresas, hostelería y colectividades de la
          Vall d'Albaida.
        </p>
      </div>

      <div>
        <h3 class="mb-3 text-sm font-semibold uppercase tracking-wider text-white">Tienda</h3>
        <ul class="space-y-2 text-sm">
          <li><NuxtLink to="/catalogo" class="hover:text-white">Todo el catálogo</NuxtLink></li>
          <li><NuxtLink to="/categoria/productos-quimicos" class="hover:text-white">Productos químicos</NuxtLink></li>
          <li><NuxtLink to="/categoria/menaje-y-hosteleria" class="hover:text-white">Menaje y hostelería</NuxtLink></li>
          <li><NuxtLink to="/carrito" class="hover:text-white">Mi carrito</NuxtLink></li>
          <li><NuxtLink to="/cuenta" class="hover:text-white">Mi cuenta</NuxtLink></li>
        </ul>
      </div>

      <div>
        <h3 class="mb-3 text-sm font-semibold uppercase tracking-wider text-white">Contacto</h3>
        <ul class="space-y-2 text-sm">
          <li class="flex items-center gap-2">
            <UIcon name="i-lucide-map-pin" class="size-4 text-neteco-400" /> Ontinyent, Valencia
          </li>
          <li>
            <a href="tel:600861334" class="flex items-center gap-2 hover:text-white"
              ><UIcon name="i-lucide-phone" class="size-4 text-neteco-400" /> 600 861 334</a
            >
          </li>
          <li>
            <a href="tel:637442546" class="flex items-center gap-2 hover:text-white"
              ><UIcon name="i-lucide-phone" class="size-4 text-neteco-400" /> 637 442 546</a
            >
          </li>
          <li>
            <a href="mailto:administracion@neteco.es" class="flex items-center gap-2 hover:text-white"
              ><UIcon name="i-lucide-mail" class="size-4 text-neteco-400" /> administracion@neteco.es</a
            >
          </li>
        </ul>
      </div>

      <div>
        <h3 class="mb-3 text-sm font-semibold uppercase tracking-wider text-white">Ayuda a la compra</h3>
        <ul class="space-y-2 text-sm">
          <li><NuxtLink to="/envios" class="hover:text-white">Envíos y reparto</NuxtLink></li>
          <li><NuxtLink to="/formas-de-pago" class="hover:text-white">Formas de pago</NuxtLink></li>
          <li><NuxtLink to="/devoluciones" class="hover:text-white">Devoluciones</NuxtLink></li>
          <li><NuxtLink to="/contacto" class="hover:text-white">Contacto y soporte</NuxtLink></li>
          <li><NuxtLink to="/ayuda" class="hover:text-white">Centro de ayuda</NuxtLink></li>
          <li><NuxtLink to="/accesibilidad" class="hover:text-white">Accesibilidad</NuxtLink></li>
          <li><a href="https://neteco.es" target="_blank" rel="noopener" class="hover:text-white">Quiénes somos</a></li>
          <li>
            <a :href="runtime.public.legalTermsUrl" target="_blank" rel="noopener" class="hover:text-white"
              >Aviso legal y condiciones</a
            >
          </li>
          <li>
            <button class="hover:text-white" @click="configureCookies">Configurar cookies</button>
          </li>
        </ul>
        <p class="mt-4 flex items-center gap-2 text-xs text-slate-400">
          <UIcon name="i-lucide-truck" class="size-4" /> Reparto propio en Ontinyent y la Vall d'Albaida
        </p>
      </div>
    </div>

    <div class="border-t border-white/10">
      <div
        class="mx-auto flex max-w-[1600px] flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-slate-400 sm:flex-row"
      >
        <p>© {{ year }} Maria Carmen González Nacher · Todos los derechos reservados.</p>
        <p v-if="!isProduction" class="rounded-full bg-white/5 px-3 py-1">
          Demo interna · los productos y precios no son reales
        </p>
      </div>
    </div>
  </footer>
</template>
