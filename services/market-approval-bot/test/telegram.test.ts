import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { approvalKeyboard, renderProposal } from "../src/telegram.js";

describe("Telegram proposal rendering", () => {
  it("renders group confirmation and admin override actions", () => {
    assert.deepEqual(approvalKeyboard("p1"), [
      [{ text: "Confirm", callback_data: "confirm:p1" }],
      [
        { text: "Admin approve", callback_data: "approve:p1" },
        { text: "Deny", callback_data: "deny:p1" },
      ],
    ]);
  });

  it("shows admin manual resolver and proposer audit identity", () => {
    const text = renderProposal({
      proposalId: "p1",
      question: "Will DarkBox be selected as a finalist?",
      proposerTelegramId: "123",
      proposerTelegramUsername: "ocean",
    });
    assert.match(text, /Resolution type: DarkBox admin manual/);
    assert.match(text, /Telegram proposer: @ocean/);
    assert.match(text, /One DarkBox group confirmation/);
  });
});
