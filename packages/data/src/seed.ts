import { createDatabase } from "./index.js";
import { assertSyntheticDatabaseUrl } from "@pdaa/platform";
if (
  process.env.NODE_ENV === "production" ||
  process.env.DATA_MODE !== "synthetic"
)
  throw new Error("Seed requires non-production synthetic mode");
if (!process.env.PDAA_DATABASE_URL || !process.env.CUSTOMER_ID)
  throw new Error("Database and customer configuration required");
const db = createDatabase(
  assertSyntheticDatabaseUrl(process.env.PDAA_DATABASE_URL).toString(),
);
try {
  const customerId = process.env.CUSTOMER_ID;
  const portfolioId = "20000000-0000-4000-8000-000000000001";
  await db.customer.upsert({
    where: { id: customerId },
    create: { id: customerId, name: "Synthetic delivery portfolio" },
    update: {},
  });
  await db.portfolio.upsert({
    where: { id: portfolioId },
    create: { id: portfolioId, customerId, name: "Digital delivery" },
    update: {},
  });
  for (const [id, code, name, description, reportedStatus] of [
    [
      "30000000-0000-4000-8000-000000000001",
      "ATL",
      "Atlas · Customer platform",
      "A synthetic customer-platform delivery project. Source ingestion and assurance workflows are upcoming.",
      "GREEN",
    ],
    [
      "30000000-0000-4000-8000-000000000002",
      "DRA",
      "Draco · Data migration",
      "A synthetic restricted project used to verify project-level access boundaries.",
      "AMBER",
    ],
  ])
    await db.project.upsert({
      where: { id: id! },
      create: {
        id: id!,
        customerId,
        portfolioId,
        code: code!,
        name: name!,
        description: description!,
        reportedStatus: reportedStatus!,
      },
      update: {},
    });
  for (const subject of ["pm-atlas", "leader-atlas"]) {
    const key = {
      customerId,
      subject,
      scopeType: "project",
      scopeId: "30000000-0000-4000-8000-000000000001",
    };
    await db.accessGrant.upsert({
      where: { customerId_subject_scopeType_scopeId: key },
      create: {
        ...key,
        role: subject === "pm-atlas" ? "project_manager" : "leadership",
      },
      update: {},
    });
  }
  console.log(
    "Synthetic Atlas/Draco seed ready. Only Atlas is granted to demo business identities.",
  );
} finally {
  await db.$disconnect();
}
