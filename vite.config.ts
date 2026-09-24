import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      '/api/adsb': {
        target: 'https://opendata.adsb.fi',
        changeOrigin: true,
        rewrite: (path) => {
          const query = new URL(path, 'http://localhost').searchParams
          const lat = query.get('lat') ?? ''
          const lon = query.get('lon') ?? ''
          const dist = query.get('dist') ?? '50'
          return `/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`
        },
      },
      '/api/elevation': {
        target: 'https://api.open-meteo.com',
        changeOrigin: true,
        rewrite: (path) => {
          const query = new URL(path, 'http://localhost').searchParams
          const latitude = query.get('lat') ?? ''
          const longitude = query.get('lon') ?? ''
          return `/v1/elevation?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`
        },
      },
    },
  },
})
