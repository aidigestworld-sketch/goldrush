// Prisma Client singleton, wired with the pg driver adapter.
//
// Prisma 7 requires an explicit driver adapter for every database —
// PrismaClient no longer connects on its own from a bare `url` in
// schema.prisma (that's why db pull/generate needed prisma.config.ts,
// and why the runtime client needs this file). One instance is
// created here and reused everywhere else in the app — never
// `new PrismaClient()` a second time in application code.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });
