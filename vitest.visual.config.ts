import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Gated visual (oMLX) tests only — `npm run test:visual`.
export default defineConfig({
  resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
  test: {
    environment: "node",
    include: ["tests/**/*.omlx.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 180000,
    hookTimeout: 30000,
    pool: "threads",
  },
});
