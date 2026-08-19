import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const PRODUCTION_API_BASE_URL = 'https://eco-oil-api.onrender.com/api/v1';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiBaseUrl = env.VITE_API_BASE_URL
    || (mode === 'development' ? '/api/v1' : PRODUCTION_API_BASE_URL);

  return {
    base: './',
    plugins: [react()],
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiBaseUrl),
    },
    resolve: {
      alias: {
        '@eco-oil/shared-types': fileURLToPath(new URL('../../packages/shared-types/src/index.ts', import.meta.url)),
      },
    },
    build: {
      modulePreload: { polyfill: false },
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name].module.js',
          chunkFileNames: 'assets/[name].[hash].module.js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
