import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  output: "static",
  build: {
    format: "directory",
  },
  vite: {
    build: {
      // Keep scripts as same-origin files so the server's CSP needs no inline exception.
      assetsInlineLimit: 0,
    },
    resolve: {
      alias: {
        "@": projectDirectory,
      },
    },
    plugins: [tailwindcss()],
  },
});
