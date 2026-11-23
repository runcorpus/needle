export const model = "typesafe-ai/jev";

export const questions = {
  accuracy: {
    type: "choice",
    instructions:
      "Compare the answer with the reference in the context of the question.",
    criteria: {
      A: "Correct. Gives the requested information and agrees with the reference. Accept equivalent wording, details implied by the question, obvious name typos, and numbers that match the reference's precision.",
      B: "Incorrect. Gives a wrong fact or a conflicting alternative, or presents an incomplete answer as complete. Hedging does not excuse an incorrect claim.",
      C: "Not attempted. Abstains or explicitly leaves the requested fact unresolved, without contradicting the reference.",
    },
    expected: "A",
  },
} as const;
