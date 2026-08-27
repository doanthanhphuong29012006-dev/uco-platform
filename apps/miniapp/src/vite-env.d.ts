/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ESTIMATED_PRICE_PER_LITER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
