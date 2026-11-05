import { defineConfig } from "drizzle-kit";

// Vireo's own migrations: hosts run them with their driver's migrator (src/migrations.ts).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  strict: true,
});
