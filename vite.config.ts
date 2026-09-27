import { defineConfig } from "vite";

const buildId = new Date().toISOString().slice(0, 16).replace("T", " ");

export default defineConfig({
  // Relative asset URLs. The app is reached both directly on :8080 and through
  // a reverse proxy that mounts it under a path prefix; Vite's default absolute
  // "/assets/..." resolves above that prefix and 404s at the proxy.
  base: "./",

  define: {
    // Shown in the startup log line, so it is obvious at a glance which build
    // the browser is running.
    __BUILD_ID__: JSON.stringify(buildId),
  },
  build: {
    target: "es2022",
    // Content-hashed filenames are a large part of why a build step is worth
    // it here: they let nginx cache assets forever and make the old manual
    // ?v= bumping and the blanket no-store policy unnecessary.
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
});
