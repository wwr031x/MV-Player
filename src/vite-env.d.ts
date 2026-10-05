/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_NETEASE_API_BASE: string;
  readonly VITE_LISTEN_TOGETHER_WS_URL: string;
  readonly VITE_CLIENT_BASE_PATH: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
