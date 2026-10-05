import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const devPages = !!process.env.DEV_PAGES;

/** Ships the LiteRT-LM WebAssembly runtime with the site instead of loading it from a CDN. */
function litertWasm(): Plugin {
  return {
    name: 'litert-wasm',
    apply: 'build',
    closeBundle() {
      const out = resolve(__dirname, 'dist/litert');
      mkdirSync(out, { recursive: true });
      cpSync(resolve(__dirname, 'node_modules/@litert-lm/core/wasm'), out, { recursive: true });
    },
  };
}

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  optimizeDeps: { exclude: ['@litert-lm/core'] },
  // evaluation and capture runs use a second dev server without hot reload, so edits cannot interrupt them
  server: process.env.NO_HMR ? { hmr: false, watch: null } : undefined,
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: devPages
        ? { main: resolve(__dirname, 'index.html'), build: resolve(__dirname, 'build.html'), eval: resolve(__dirname, 'eval.html'), test: resolve(__dirname, 'check-test.html') }
        : { main: resolve(__dirname, 'index.html') },
    },
  },
  plugins: [
    litertWasm(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Waymark',
        short_name: 'Waymark',
        description: 'A trail guide you listen to. Gemma 4 runs in your browser and writes spoken cues for real trails from open map data.',
        theme_color: '#1d2b24',
        background_color: '#eef2ec',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,svg}', 'guides/*.json'],
        globIgnores: ['**/litert/**', '**/trails/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallbackDenylist: [/\/litert\//],
        runtimeCaching: [
          { urlPattern: /\/trails\/.*\.(json|png)$/, handler: 'CacheFirst', options: { cacheName: 'trails', expiration: { maxEntries: 40 } } },
          { urlPattern: /\/litert\/.*\.(js|wasm)$/, handler: 'CacheFirst', options: { cacheName: 'litert', expiration: { maxEntries: 8 } } },
          { urlPattern: /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\//, handler: 'CacheFirst', options: { cacheName: 'elevation', expiration: { maxEntries: 400 } } },
        ],
      },
    }),
  ],
});
