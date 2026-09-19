import { defineConfig } from "vite";

// ブラウザから見るとアプリとサーバーは1つのオリジン。開発中はこの中継が
// /api と /ws をサーバー(:8787)へ渡し、本番はサーバーが web/dist を配る。
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
