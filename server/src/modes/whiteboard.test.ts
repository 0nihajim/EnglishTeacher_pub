import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UiMessage } from "../../../shared/messages";
import type { CoachHost } from "./types";
import { WhiteboardCoach } from "./whiteboard";

function host(ui: UiMessage[], nudges: string[] = []): CoachHost {
  return {
    showUi: (msg) => ui.push(msg),
    nudge: (text) => nudges.push(text),
    log: () => {},
    teacherSpeaking: () => false,
  };
}

describe("WhiteboardCoach", () => {
  it("言い直しを画面に出すだけで、フレームは数えるだけで先生に差し込まない", () => {
    const ui: UiMessage[] = [], nudges: string[] = [];
    const coach = new WhiteboardCoach(host(ui, nudges));
    coach.boardChanged(1);
    coach.boardChanged(2);
    assert.equal(coach.frameCount, 2);
    assert.deepEqual(nudges, []);

    const reply = coach.onToolCall("show_recast", {
      original: "The API talk to database.",
      better: "The API talks to the database.",
      kind: "correction",
      note: "三単現の s と the",
    });
    assert.equal(reply.scheduling, "SILENT");
    assert.equal(ui[0]?.widget, "recast");

    const card = coach.onToolCall("show_term_card", { term: "load balancer" });
    assert.equal(card.response.shown, true);
    assert.equal(ui[1]?.widget, "term_card");
  });

  it("知らないツールと、別モードの進行ツールは断る", () => {
    const ui: UiMessage[] = [];
    const coach = new WhiteboardCoach(host(ui));
    assert.equal(coach.onToolCall("report_target", { term: "x", outcome: "used_well" }).response.shown, false);
    assert.equal(coach.onToolCall("nonsense", {}).response.shown, false);
    assert.deepEqual(ui, []);
  });

  it("チェックポイントから数を戻せる", () => {
    const coach = new WhiteboardCoach(host([]));
    coach.boardChanged(1);
    coach.teacherTurnDone();
    const snapshot = coach.checkpoint();
    const other = new WhiteboardCoach(host([]));
    assert.equal(other.restore(snapshot), true);
    assert.equal(other.frameCount, 1);
    assert.equal(other.restore({ version: 1, mode: "scene", state: {} }), false);
  });
});
