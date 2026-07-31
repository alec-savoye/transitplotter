/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_HTTP?: string;
  readonly VITE_SERVER_WS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
