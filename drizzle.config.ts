import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/db/schema/users.ts",
    "./src/db/schema/alerts.ts",
    "./src/db/schema/referrals.ts",
    "./src/db/schema/settings.ts",
  ],
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
