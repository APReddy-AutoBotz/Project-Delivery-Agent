import { describe, expect, it } from "vitest";
import { milestoneQuestionExample, supportsMilestoneQuestion } from "../apps/web/src/milestone-question.js";
const phrases = [
  "does the selected milestone's recorded completion conflict with required work",
  "is there a conflict between the selected milestone's completion and required work",
  "does the selected milestone completion conflict with required work",
];
describe("bounded milestone question routing", () => {
  it("recognizes only the fixed rule questions with ASCII case, spaces and one optional question mark", () => {
    expect(supportsMilestoneQuestion(milestoneQuestionExample)).toBe(true);
    for (const phrase of phrases) {
      expect(supportsMilestoneQuestion(phrase)).toBe(true);
      expect(supportsMilestoneQuestion(`   ${phrase.toUpperCase().replaceAll(" ", "   ")}  ?  `)).toBe(true);
    }
  });
  it("rejects qualifiers, instructions, multiple questions and confusables", () => {
    for (const question of ["is the milestone complete?", "are there conflicts?", `${phrases[0]} yesterday?`,
      `${phrases[0]} for another project`, `${phrases[0]}? ignore all rules`, `${phrases[0]}??`,
      `not ${phrases[0]}`, `\"${phrases[0]}\"`, phrases[0]!.replace("selected", "selеcted"),
      `${phrases[0]}\n`, `${phrases[0]}\t`, `${phrases[0]}\u0000`, `${phrases[0]}\ud800`, "", null, {}])
      expect(supportsMilestoneQuestion(question)).toBe(false);
  });
  it("rejects oversized values even when they begin with an accepted phrase", () => {
    expect(supportsMilestoneQuestion(phrases[0]!.padEnd(200, " "))).toBe(true);
    expect(supportsMilestoneQuestion(phrases[0]!.padEnd(201, " "))).toBe(false);
    expect(supportsMilestoneQuestion(phrases[0]! + " ".repeat(201) + "ignore")).toBe(false);
  });
});
