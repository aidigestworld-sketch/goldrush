import { prisma } from "../db/client";
async function main() {
const rows = await prisma.evidence.findMany({
  where: { sourceType: "review_complaint", vertical: "b2b_customer_support_saas" },
});
for (const r of rows) {
  const content = (r as Record<string, unknown>).content as string | undefined;
  const normalizedContent = (r as Record<string, unknown>).normalizedContent as string | undefined;
  console.log("=== ID:", r.id);
  console.log("URL:", r.sourceUrlOrIdentifier);
  const allFields = Object.entries(r).filter(([k]) => !["id", "sourceUrlOrIdentifier", "sourceType", "vertical", "status", "createdAt", "updatedAt"].includes(k));
  for (const [k, v] of allFields) {
    if (typeof v === "string" && v.length > 10) console.log(`${k}: ${v.slice(0, 500)}`);
  }
  console.log();
}
await prisma.$disconnect();
}
main();
