import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: ".",
  publicDir: "public",
  resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
  server: { port: 5173, host: true },
});
