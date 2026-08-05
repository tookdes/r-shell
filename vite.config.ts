import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from 'url';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Split heavy third-party vendors into their own chunks so the main bundle
  // stays small and xterm/recharts/codemirror only load when actually used.
  build: {
    // codemirror's full language bundle is ~955 KB; it lives in its own
    // vendor chunk and is cached by the webview between launches.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@xterm") || id.includes("xterm")) return "vendor-xterm";
          if (id.includes("@codemirror") || id.includes("codemirror") || id.includes("@lezer")) {
            return "vendor-editor";
          }
          if (id.includes("recharts") || id.includes("d3-") || id.includes("victory-vendor")) {
            return "vendor-charts";
          }
          if (id.includes("@radix-ui")) return "vendor-radix";
          if (id.includes("@tauri-apps/api")) return "vendor-tauri-api";
          if (id.includes("lucide-react")) return "vendor-icons";
          return undefined;
        },
      },
    },
  },
}));
