/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './components/**/*.{js,vue,ts}',
    './layouts/**/*.vue',
    './pages/**/*.vue',
    './plugins/**/*.{js,ts}',
    './app.vue',
    './app/**/*.vue',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#009AC9',
          light: '#45B5E5',
          pale: '#C5E8F2',
          dark: '#0088B3',
        }
      }
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
