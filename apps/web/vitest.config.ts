import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // `@` maps to the apps/web root — matches Next.js convention and
      // avoids Vite mis-resolving relative imports from paths that contain
      // dynamic segment brackets like `[runId]`.
      "@": path.resolve(__dirname, "./"),
      // Redirect Next.js-specific imports to lightweight test doubles so
      // components render in jsdom without the full Next.js runtime.
      "next/link": path.resolve(__dirname, "./__mocks__/next-link.tsx"),
      "next/navigation": path.resolve(__dirname, "./__mocks__/next-navigation.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
