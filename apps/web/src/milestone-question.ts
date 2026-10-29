// This recognizes only the named milestone consistency rule. It does not
// resolve identities, authority, time periods or broader questions.
const questions = new Set([
  "does the selected milestone's recorded completion conflict with required work",
  "is there a conflict between the selected milestone's completion and required work",
  "does the selected milestone completion conflict with required work",
]);
export const milestoneQuestionExample = "Does the selected milestone's recorded completion conflict with required work?";
export function supportsMilestoneQuestion(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 200 || !/^[A-Za-z '?]*$/.test(value)) return false;
  let text = value.replace(/ +/g, " ").trim().toLowerCase();
  if (text.endsWith("?")) text = text.slice(0, -1).trimEnd();
  return questions.has(text);
}
