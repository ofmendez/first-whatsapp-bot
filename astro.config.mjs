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
    resolve: {
      alias: {
        "@": projectDirectory,
      },
    },
    plugins: [tailwindcss()],
  },
});
