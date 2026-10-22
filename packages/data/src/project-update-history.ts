import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalSubjectSchema } from "@pdaa/domain";

const originalBodySchema = z.strictObject({
  rendererRevision: z.literal("project-update-capture@1"),
  body: z.string().min(1).max(65536),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  reviewerSubjects: z.array(canonicalSubjectSchema).max(32),
}).refine((value) => new Set(value.reviewerSubjects).size === value.reviewerSubjects.length);

/** Server-only projection; original digests and reviewer identities stay internal. */
export function projectEscalationHistoryBody(value: unknown): string | null {
  const parsed = originalBodySchema.safeParse(value);
  if (!parsed.success) return null;
  const input = parsed.data;
  if (createHash("sha256").update(input.body, "utf8").digest("hex") !== input.contentDigest)
    return null;
  const suffix = "\nRaw-response reviewers: " +
    (input.reviewerSubjects.length ? input.reviewerSubjects.join(", ") : "only you");
  if (!input.body.endsWith(suffix)) return null;
  const text = input.body.slice(0, -suffix.length) +
    "\nRaw-response readership details are withheld in this history view.";
  return Buffer.byteLength(text, "utf8") <= 65536 ? text : null;
}
