<script setup lang="ts">
import { ArrowLeft, Cookie } from 'lucide-vue-next'

useHead({
  title: 'Política de Cookies - NETECO'
})
</script>

<template>
  <div class="container mx-auto px-6 py-20 lg:py-32 max-w-4xl min-h-screen">
    <NuxtLink
      to="/"
      class="inline-flex items-center gap-2 text-sky-600 hover:text-sky-700 font-bold mb-8 transition group"
    >
      <ArrowLeft class="w-5 h-5 group-hover:-translate-x-1 transition" />
      Volver al inicio
    </NuxtLink>

    <div class="bg-white p-8 md:p-12 rounded-3xl shadow-xl border border-slate-100">
      <div class="flex items-center gap-4 mb-8 pb-8 border-b border-slate-200">
        <div class="p-4 bg-sky-100 rounded-2xl">
          <Cookie class="w-8 h-8 text-sky-600" />
        </div>
        <h1 class="text-3xl md:text-4xl font-bold text-slate-900">Política de Cookies</h1>
      </div>

      <div class="prose prose-lg prose-slate max-w-none prose-headings:text-slate-900 prose-headings:font-bold prose-h3:text-xl prose-h3:mt-8 prose-h3:mb-4 prose-p:text-slate-600 prose-p:leading-relaxed prose-li:text-slate-600 prose-strong:text-slate-800">
        <p class="text-lg leading-relaxed">
          En NETECO utilizamos cookies propias y de terceros para mejorar nuestros servicios y mostrarle publicidad
          relacionada con sus preferencias mediante el análisis de sus hábitos de navegación.
        </p>

        <h3>¿Qué son las cookies?</h3>
        <p>
          Una cookie es un fichero que se descarga en su ordenador al acceder a determinadas páginas web. Las cookies
          permiten a una página web, entre otras cosas, almacenar y recuperar información sobre los hábitos de
          navegación de un usuario o de su equipo.
        </p>

        <h3>Tipos de cookies que utiliza esta web</h3>
        <ul>
          <li>
            <strong>Cookies técnicas:</strong> Son aquellas que permiten al usuario la navegación a través de una
            página web, plataforma o aplicación y la utilización de las diferentes opciones o servicios que en ella
            existan.
          </li>
          <li>
            <strong>Cookies de análisis:</strong> Son aquellas que bien tratadas por nosotros o por terceros, nos
            permiten cuantificar el número de usuarios y así realizar la medición y análisis estadístico de la
            utilización que hacen los usuarios del servicio ofertado.
          </li>
        </ul>

        <h3>Desactivación y eliminación de cookies</h3>
        <p>
          Tiene la opción de permitir, bloquear o eliminar las cookies instaladas en su equipo mediante la
          configuración de las opciones del navegador instalado en su equipo. Al desactivar cookies, algunos servicios
          disponibles podrían dejar de estar operativos.
        </p>
      </div>
    </div>
  </div>
</template>
