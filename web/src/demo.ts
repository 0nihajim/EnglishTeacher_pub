/**
 * 開発用の見本。API キーが無いうちにカードの見た目だけ直すとき、
 * /?demo=card などで舞台とカードを出せる(main.ts 参照)。
 *   card / targets / recast / summary … シーン会話
 *   drill / answer … 瞬間英作文
 *   board / review / compare … 話し直し(板は画像の見本と一緒に出る)
 */
import type { AssessmentItem, TeachingNotes, UiMessage } from "../../shared/messages";

const RETELL_TEACHING: TeachingNotes = {
  alternative: {
    phrase: "I created the login page.",
    usage: "built と近い意味で、何を作ったかを端的に伝える言い方です。",
  },
  collocation: {
    phrase: "run into + a problem",
    meaning: "問題にぶつかる。run into の後に、直面した問題を置きます。",
    example: "I ran into a problem with the API.",
  },
  practice: "テスト中に困ったことを、ran into を使って一文で説明してみよう。",
};
const FIRST_ASSESSMENT: AssessmentItem[] = [
  { criterion: "meaning", score: 3, evidence: "It was difficult because API", reason: "APIで苦労したことは伝わりますが、何が変わったのかを文で補うと明確になります。" },
  { criterion: "grammar", score: 2, evidence: "I make login page", reason: "終えた作業には過去形 built、特定の画面には the を使います。" },
  { criterion: "naturalness", score: 3, evidence: "It was difficult because API", reason: "because の後は主語と動詞。名詞を続けるなら because of the API とします。" },
  { criterion: "range", score: 2, evidence: "Next, I want to test.", reason: "基本的な文で説明できています。困難を表す ran into a problem も使ってみましょう。" },
];
const SECOND_ASSESSMENT: AssessmentItem[] = [
  { criterion: "meaning", score: 4, evidence: "It was hard because the API changed.", reason: "何が難しく、その原因が何かを一文で伝えられています。" },
  { criterion: "grammar", score: 4, evidence: "I built the login page last week.", reason: "過去形、冠詞、時を表す語句が適切です。" },
  { criterion: "naturalness", score: 4, evidence: "It was hard because the API changed.", reason: "because + 主語 + 動詞が自然に使えています。because of は別の構文なので、今回は使用済みには数えません。" },
  { criterion: "range", score: 3, evidence: "Next, I will write tests.", reason: "過去の作業から次の予定へ展開できています。理由の説明も加わりました。" },
];

const RETELL_IMPROVEMENTS = [
  { original: "I make login page", better: "I built the login page", note: "終わったことなので built" },
  { original: "It was difficult because API", better: "It was hard because of the API", note: "because of + 名詞" },
];

const SAMPLES: Record<string, UiMessage> = {
  board: {
    widget: "retell_board",
    props: {
      phase: "retelling",
      title: "2回目 — 画像とキーワードだけで",
      lines: ["my app", "login page", "built", "API change", "next: tests"],
    },
  },
  review: {
    widget: "retell_review",
    props: {
      improvements: RETELL_IMPROVEMENTS,
      points: ["アプリの画面", "ログイン画面を作った", "API で苦労"],
      assessment: FIRST_ASSESSMENT,
      teaching: RETELL_TEACHING,
    },
  },
  compare: {
    widget: "retell_compare",
    props: {
      first: {
        transcript: "This is my app. I make login page. It was difficult because API... API change. Next, I want to test.",
        seconds: 48,
        words: 21,
        points: ["アプリの画面", "ログイン画面を作った", "API で苦労"],
        hints: 1,
        assessment: FIRST_ASSESSMENT,
      },
      second: {
        transcript:
          "This is my app. I built the login page last week. It was hard because the API changed. Next, I will write tests.",
        seconds: 41,
        words: 24,
        points: ["アプリの画面", "ログイン画面を作った", "API で苦労", "次はテスト"],
        hints: 0,
        assessment: SECOND_ASSESSMENT,
      },
      improvements: [
        { ...RETELL_IMPROVEMENTS[0]!, used: true },
        { ...RETELL_IMPROVEMENTS[1]!, used: false },
      ],
      comment: "時制が安定して、文がつながった。because of は次に使ってみよう。",
      teaching: RETELL_TEACHING,
    },
  },
  card: {
    widget: "term_card",
    props: {
      term: "Could you say that again?",
      reading: "クッジュー・セイ・ザッ・アゲン",
      meaning: "もう一度言ってもらえますか",
      example: "Sorry, could you say that again? That was a little fast.",
    },
  },
  targets: {
    widget: "targets",
    props: {
      title: "IT系: 朝会で進捗を話す",
      targets: [
        { term: "I'm working on", meaning: "〜に取り組んでいる", status: "used_well" },
        { term: "blocked by", meaning: "〜で止まっている", status: "heard" },
        { term: "roll out", meaning: "展開する、リリースする", status: "modeled" },
        { term: "figure out", meaning: "原因や方法を突き止める", status: "used_with_error" },
        { term: "should be done by", meaning: "〜までには終わるはず", status: "unused" },
      ],
    },
  },
  recast: {
    widget: "recast",
    props: {
      original: "I do the login bug now.",
      better: "I'm working on the login bug.",
      note: "進行中の作業は I'm working on",
      kind: "correction",
      teaching: {
        alternative: { phrase: "I'm fixing the login bug.", usage: "不具合の修正中だと具体的に伝えます。working on は調査なども含む広い言い方です。" },
        collocation: { phrase: "work on + noun", meaning: "作業や問題に取り組む。on の後に取り組む対象を置きます。", example: "I'm working on the login issue." },
        practice: "今取り組んでいる別の作業を、working on を使って一文で伝えてみよう。",
      },
    },
  },
  drill: {
    widget: "drill_prompt",
    props: { index: 3, total: 6, ja: "API の変更で止まっています。", limitMs: 8_000 },
  },
  answer: {
    widget: "drill_answer",
    props: {
      ja: "API の変更で止まっています。",
      answer: "I'm blocked by the API change.",
      said: "I'm blocked on API change.",
      verdict: "close",
      note: "冠詞の the を忘れずに",
      latencyMs: 2_300,
      teaching: {
        alternative: { phrase: "The API change is holding me up.", usage: "作業が遅れていることを会話で伝える言い方。blocked by は進められない原因を明示します。" },
        collocation: { phrase: "be blocked by + noun", meaning: "〜が原因で進められない。by の後に原因を置きます。", example: "We're blocked by a missing API key." },
        practice: "仕様の確認待ちで作業が止まっている状況を、blocked by を使って説明してみよう。",
      },
    },
  },
  summary: {
    widget: "summary",
    props: {
      title: "IT系: 朝会で進捗を話す — 瞬間英作文の結果",
      lines: [
        { label: "今ログインのバグに取り組んでいます。", value: "正解 · 1.8s · I'm working on the login bug.", tone: "good" },
        { label: "API の変更で止まっています。", value: "惜しい · 2.3s · I'm blocked by the API change.", tone: "warn" },
        { label: "金曜に新しいバージョンをリリースします。", value: "不正解 · 4.1s · We'll roll out the new version on Friday.", tone: "bad" },
        { label: "明日までには終わるはずです。", value: "スキップ · It should be done by tomorrow.", tone: "muted" },
        { label: "再 金曜に新しいバージョンをリリースします。", value: "正解 · 2.0s · We'll roll out the new version on Friday.", tone: "good" },
      ],
      footer: "正解 2 / 5 · 平均反応 2.6 秒",
    },
  },
};

/** URL の ?demo= に対応する見本。無ければ undefined。 */
export function demoSample(search: string): UiMessage | undefined {
  const key = new URLSearchParams(search).get("demo");
  return key ? SAMPLES[key] : undefined;
}

/** 板の見本に載せる画像。アプリの画面らしい絵を canvas で描く(実物の画像は要らない)。 */
export function demoImageUrl(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#1a2236";
  ctx.fillRect(0, 0, 640, 400);
  ctx.fillStyle = "#0f1421";
  ctx.fillRect(0, 0, 640, 44);
  ctx.fillStyle = "#6ea8ff";
  ctx.fillRect(16, 14, 16, 16);
  ctx.fillStyle = "#cfd7e6";
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillText("My App — Sign in", 44, 30);
  ctx.fillStyle = "#232c44";
  ctx.beginPath();
  ctx.roundRect(170, 90, 300, 220, 14);
  ctx.fill();
  ctx.fillStyle = "#8b98ad";
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillText("Email", 196, 132);
  ctx.fillText("Password", 196, 196);
  ctx.fillStyle = "#0f1421";
  ctx.beginPath();
  ctx.roundRect(196, 142, 248, 34, 8);
  ctx.roundRect(196, 206, 248, 34, 8);
  ctx.fill();
  const grad = ctx.createLinearGradient(196, 0, 444, 0);
  grad.addColorStop(0, "#6ea8ff");
  grad.addColorStop(1, "#b98cff");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(196, 262, 248, 34, 17);
  ctx.fill();
  ctx.fillStyle = "#0b0d12";
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.fillText("Sign in", 296, 284);
  return canvas.toDataURL("image/png");
}
