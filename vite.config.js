import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 4173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    target: 'es2020',
  },
  define: {
    __DEFAULT_RELAY_URL__: JSON.stringify(process.env.VITE_RELAY_URL || ''),
  },
});
