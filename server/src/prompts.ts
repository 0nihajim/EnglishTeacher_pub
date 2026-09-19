/**
 * モデルに渡す文字列を1か所に集める。中身は2種類あって、その区別が要点。
 *
 * - 人格と進め方 — 先生が誰で、モードごとに何をするか。`server/prompts/` の
 *   markdown から読む。このアプリを自分向けに変えるならまずここを書き換える。
 *   開幕の一言はシーンの中身から組むので、コード側(sceneGreeting / drillGreeting)。
 * - 機構 — ツールが動くための指示と、進行の差し込み([進行] の文)。見た目の
 *   好みではなく配線なので、書き換えるとカードが出なくなったり、先生が自分の
 *   ツール呼び出しを実況し始めたりする。だからコード側に置いてある。
 *
 * 元デモとの差: GPT-Live 版には「ライブモデルに委譲させる」ためのプロンプトと、
 * 「委譲を頼んでも一度も発火しなかった」実測を踏まえた迂回策が必要だった。
 * Gemini はライブモデル自身がツールを持つので、その層が消えている。
 */

import { config } from "./config";
import { promptTemplates } from "./generated/content";
import type { TellingAnalysis } from "./flash";
import type { DrillItem, Scene } from "./scenes";

function promptFile(name: string, fallback: string): string {
  return promptTemplates[name] ?? fallback;
}

// ── 人格(書き換えるのは server/prompts/*.md のほう) ──────────────────────────

export const PERSONA = promptFile(
  "instructions.md",
  "You are a warm English conversation coach in a live spoken lesson with a Japanese learner. " +
    "Keep every reply to one or two sentences. Never use lists or formatting: everything you " +
    "produce is spoken aloud.",
);

/** シーン会話の進め方(scene.md)。人格の後ろに付く。 */
export const SCENE_ADDENDUM =
  "\n\n" +
  promptFile(
    "scene.md",
    "You are running a role-play scene. The app tells you the situation and today's target " +
      "expressions. Create natural openings for them, one or two at a time. When the learner " +
      "misses one, rephrase what they said with the target, call show_recast, and have them say " +
      "it back once.",
  );

/** 瞬間英作文の進め方(drill.md)。人格の後ろに付く。 */
export const DRILL_ADDENDUM =
  "\n\n" +
  promptFile(
    "drill.md",
    "You are running an instant-translation drill. The app hands you one Japanese sentence at a " +
      "time with the model answer. Read it aloud once, wait in silence, judge the learner's " +
      "English, call drill_result, say the model answer in one sentence, then wait for the next.",
  );

export const REVIEW_ADDENDUM = "\n\n" + promptFile("review.md",
  "The app controls personal review. Never reveal the model before phase=model. " +
  "Judge submitted speech with review_result for the current attempt_id, then stop and await app instructions.");

/** 話し直しトレーニングの進め方(retell.md)。人格の後ろに付く。 */
export const RETELL_ADDENDUM =
  "\n\n" +
  promptFile(
    "retell.md",
    "You are running a retelling session. The learner explains one picture of their own in " +
      "English for 30 to 60 seconds; listen to the end without correcting. The app then hands you " +
      "one or two improvements to say aloud, after which the learner tells it again with only the " +
      "picture and keywords. Finish with the follow-up question the app gives you.",
  );

/**
 * 話し直しの振り返りを Flash に頼むときの方針(retell-review.md)。何を直し、何を流すか、
 * キーワードと追加の質問の作り方。JSON の項目名は flash.ts のスキーマが決めるので、
 * ここには書かない。
 */
export const RETELL_REVIEW_GUIDE = promptFile(
  "retell-review.md",
  "You review a Japanese learner's spoken explanation of their own picture. Keep their meaning " +
    "and vocabulary level; pick one or two improvements that help the story hold together; give " +
    "short English keywords for a second telling and one natural follow-up question.",
);

/** ボードの進め方(whiteboard.md)。人格の後ろに付く。 */
export const WHITEBOARD_ADDENDUM =
  "\n\n" +
  promptFile(
    "whiteboard.md",
    "You are running a whiteboard session. The learner draws on a board and talks about it in " +
      "English; the app sends you the whole board as a still picture whenever it changes, and the " +
      "newest picture is the current state. Ask about what is drawn, one question at a time, and " +
      "correct one language point per completed turn with show_recast.",
  );

// ── 言語 ─────────────────────────────────────────────────────────────────────

/** プロンプトに書くための言語名。BCP-47 の主言語部分で引く。無ければコードのまま。 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  ru: "Russian",
  ar: "Arabic",
  hi: "Hindi",
  id: "Indonesian",
  th: "Thai",
  vi: "Vietnamese",
};

export function languageName(code: string): string {
  const primary = code.split(/[-_]/)[0]?.toLowerCase() ?? "";
  return LANGUAGE_NAMES[primary] ?? code;
}

/** "English and Japanese" / "English, Japanese, and Korean"。 */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * 学習者が話す言語を限る指示。人格の直後に付く。
 *
 * ネイティブ音声モデルには入力言語を設定する項目が無く、公式ドキュメントは
 * 「使う言語は system instruction で制限する」としている。初級者の英語や
 * 日本語が別の言語として聞き取られ、先生がその言語で応じる事故を、ここで塞ぐ。
 * 空なら何も付けない(自動判定)。
 */
export function languageDirective(codes: readonly string[]): string {
  const names = [...new Set(codes.map(languageName))];
  if (names.length === 0) return "";
  const list = joinNames(names);
  const those = names.length === 1 ? "that language" : "one of those languages";
  return `

The learner speaks only ${list}. Whatever they say is ${those}, however it sounds: an unclear or
accented utterance is still ${list}, never a third language. Never hear, answer in, switch to, or
comment on any other language, and do not remark on their accent. You too speak only ${list}.`;
}

export const LANGUAGE_DIRECTIVE = languageDirective(config.gemini.inputLanguages);

/**
 * 手動の区切り(TurnTaking = manual)のときだけ付く。学習者の声は「送信」まで
 * 届かないので、間が空くのは考えている時間であり、いなくなったのではない。
 */
export const MANUAL_TURN_DIRECTIVE = `

The learner presses a button to start speaking and another to send what they said, so their answer
reaches you only when they decide it is finished, sometimes after a long pause. Wait for it. Do not
fill short silences, and never treat a pause as the end of their turn.`;

// ── 機構 ─────────────────────────────────────────────────────────────────────

/**
 * ツールの使い方。system instruction の末尾に付く。
 *
 * スキーマと説明はツール登録時に渡してある(shared/tools.ts)ので、ここには
 * スキーマが書けない振る舞いだけを書く。「カードが出たと言わない」は必須で、
 * これが無いと先生が毎回「画面を見てください」と言い出し、画面を見ていない
 * 学習者に対して嘘になる。
 */
export const TOOL_DIRECTIVE = `

On-screen cards: you can put a card on the learner's screen yourself, with show_term_card. Do it
every time you teach, translate, or correct a word or phrase — seeing it while hearing it is how it
sticks. One card per phrase; never two in the same breath. The card appears beside your speech and
does not interrupt you, so keep talking normally while it goes up.

Never say that a card has appeared. No "here you go", no "look at your screen", no "let me show
you" — the learner may not be looking, and narrating it wastes the moment. The one exception is the
progress panel, where the panel itself is the point.

Above all, do not go quiet. If you are unsure what to do next, keep the conversation moving out
loud: silence is the one failure the learner cannot recover from.`;

/** シーン会話だけのツール。TOOL_DIRECTIVE の後ろに付く。 */
export const SCENE_TOOL_DIRECTIVE = `

Three tools are specific to this scene. show_recast puts the learner's sentence next to your better
version — call it for corrections and useful alternatives, including non-target language.
Supply kind, a specific reason, and the available alternative/collocation fields.
Say the main improvement aloud briefly. report_target records how they did with a target: used_well,
used_with_error, or modeled when you had to say it for them; use the target's exact wording from
the list. Those two are silent: never mention them, and never read the target list aloud.
show_progress is the third — it puts today's targets on screen with how each one went. Call it only
when the learner asks how they are doing or when you are wrapping the scene up, and then read out
what its result hands back, briefly. Never answer a request for a new phrase with it.`;

/** 誰も何も言わない時間が続いたときの差し込み(session.ts の見張り)。 */
export const SILENCE_CHECKIN =
  "誰も話していない時間が続いている。何を待っていたとしても待つのをやめ、いますぐ声を出して" +
  "学習者に短く声をかけること。まだいるか尋ねる、励ます、いまの表現をもう一度言って促す。" +
  "沈黙のまま放置しない。";

// ── シーン会話(scene モード) ─────────────────────────────────────────────────

/** シーンの状況と今日の表現。system instruction の末尾に付く。 */
export function sceneDirective(scene: Scene): string {
  const targets = scene.targets
    .map((t, i) => `${i + 1}. "${t.term}" — ${t.meaning}${t.example ? ` (e.g. "${t.example}")` : ""}`)
    .join("\n");
  const role = scene.learnerRole ? `The learner plays: ${scene.learnerRole}.\n` : "";
  return `

Today's scene: ${scene.title}.
Situation: ${scene.situation}
${role}Target expressions the learner is practising today:
${targets}

Stay in the scene. Work toward one or two targets at a time and let the rest come naturally.
Messages beginning with [進行] may name a target to steer toward next.`;
}

export function sceneGreeting(scene: Scene): string {
  const role = scene.learnerRole ? ` (${scene.learnerRole})` : "";
  return (
    `Open with one short Japanese line naming today's scene — 「今日は「${scene.title}」の場面で` +
    `練習しましょう」くらい — then switch to English, set the scene in one or two sentences as your ` +
    `character, and ask the first question that puts the learner in their role${role}. ` +
    `Do not list the target expressions.`
  );
}

/** 未使用の表現の機会を作るよう頼む(next-turn で送る)。 */
export function sceneSteerNudge(terms: readonly string[]): string {
  return (
    `次の自分の番で、学習者が次の表現を自然に使いたくなる質問や状況を作ること: ` +
    `${terms.map((t) => `"${t}"`).join(", ")}。表現そのものは先に言わず、学習者が言えなければそのとき示す。` +
    `口にしただけでなく、文の意味・文法・使い方まで確認し、report_target で判定する。`
  );
}

export const SCENE_ALL_DONE_NUDGE =
  "今日の表現はすべて正しく使えた。区切りのよいところで会話をまとめ、よかった点を具体的に一言と今後の練習を一言" +
  "伝えて締めてよい。まとめを画面に出すには show_progress を呼ぶ。";

// ── 瞬間英作文(drill モード) ─────────────────────────────────────────────────

/** 今日の問題数と出題の仕方。system instruction の末尾に付く。 */
export function drillDirective(scene: Scene): string {
  const voice = scene.promptVoice
    ? "Read each Japanese prompt aloud exactly once, then wait in silence."
    : 'Prompts appear on the learner\'s screen only. Do not read them aloud; say "Next." and wait in silence.';
  return `

Today's drill: ${scene.title}, ${scene.drills.length} sentences. ${voice} Every prompt comes from
the app as a [進行] message with the model answer attached. Never invent prompts of your own, and
never say the model answer before the learner has tried or the app tells you they are stuck.`;
}

export function drillGreeting(scene: Scene): string {
  const cue = scene.promptVoice ? "聞いたら" : "見たら";
  return (
    `Open with one short Japanese line — 「瞬間英作文を始めましょう。日本語を${cue}、すぐ英語で` +
    `言ってください」くらい — then say in simple English that there are ${scene.drills.length} sentences ` +
    `and you will start now. Then stop and wait; the app will hand you the first sentence.`
  );
}

/** 1問を渡す(now で送る)。 */
export function drillPromptNudge(item: DrillItem, index: number, total: number, voice: boolean): string {
  const accept = item.accept.length > 0 ? ` 別解: ${item.accept.map((a) => `"${a}"`).join(", ")}。` : "";
  const answer = `模範解答(判定に使う。学習者が答える前には言わない): "${item.en}"。${accept}`;
  return voice
    ? `問題 ${index}/${total}。次の日本語文を一度だけはっきり読み上げ、あとは黙って学習者の英語を待つこと。` +
        `訳もヒントも言わない。日本語: 「${item.ja}」 ${answer}`
    : `問題 ${index}/${total} が画面に出た。日本語は読まず、「Next.」とだけ言って黙って学習者の英語を待つこと。` +
        `日本語(画面に出ているもの): 「${item.ja}」 ${answer}`;
}

/** 制限時間を過ぎた(now で送る)。 */
export function drillHintNudge(item: DrillItem): string {
  return (
    `学習者はまだ答えられていない。もし話し始めていたら何も言わず聞くこと。黙っているなら、` +
    `模範解答 "${item.en}" の最初の2〜3語だけをヒントとして言い、また待つ。`
  );
}

/** ヒントの後も無音(無音の見張りから)。 */
export function drillGiveUpNudge(item: DrillItem): string {
  return (
    `学習者はこの問題に答えられなかった。模範解答 "${item.en}" をゆっくり一度言い、一度だけ復唱させてから、` +
    `drill_result を skipped で呼ぶこと。`
  );
}

/** 答えたのに判定が来ない(無音の見張りから)。 */
export const DRILL_REPORT_REMINDER =
  "いまの答えの判定を drill_result でまだ報告していない。いますぐ判定(correct / close / wrong)を" +
  "報告すること。喋り直しは不要。";

/** 全問終わった(now で送る)。 */
export function drillFinishNudge(
  correct: number,
  total: number,
  avgSec: number | null,
  missed: readonly string[],
): string {
  const avg = avgSec === null ? "" : `平均の反応は ${avgSec.toFixed(1)} 秒。`;
  const miss =
    missed.length > 0
      ? `最後まで言えなかった文: ${missed.map((m) => `"${m}"`).join(", ")}。そのうち1つだけ模範解答をもう一度言う。`
      : "最終的には全部言えた。";
  return `全問終わった。結果: 正解 ${correct}/${total}。${avg}${miss}一言ねぎらって、レッスンを締めること。次の問題は無い。`;
}

// ── 話し直しトレーニング(retell モード) ──────────────────────────────────────

/** 話す観点。板に出し、先生にも伝える。 */
export const RETELL_PROMPTS: readonly { ja: string; en: string }[] = [
  { ja: "これは何?", en: "What is it?" },
  { ja: "何をした?", en: "What did you do?" },
  { ja: "困ったこと", en: "What was hard?" },
  { ja: "次にすること", en: "What's next?" },
];

/** 板に出す行: 「これは何? — What is it?」 */
export function retellPromptLines(): string[] {
  return RETELL_PROMPTS.map((p) => `${p.ja} — ${p.en}`);
}

/** 追加の質問が Flash から取れなかったときの1問。 */
export const DEFAULT_RETELL_QUESTION = "What will you do next with this?";

/** 話し直しだけのツール。TOOL_DIRECTIVE の後ろに付く。 */
export const RETELL_TOOL_DIRECTIVE = `

In this session you have show_term_card and hide_card only. Use show_term_card for a hint or for
a phrase you teach at a hint. The review sentences are put on screen by the app, not by you: do not
call any tool for them, and do not say that they are on screen.`;

/** 画像と観点。system instruction の末尾に付く。 */
export function retellDirective(): string {
  const angles = RETELL_PROMPTS.map((p, i) => `${i + 1}. ${p.en}`).join(" ");
  return `

Today's picture is the one in the conversation; the learner chose it and will explain it. The
angles offered to them on screen: ${angles} They may follow them or not. Speak of the picture from
what you actually see in it, and never claim to see something that is not there.`;
}

export function retellGreeting(): string {
  return (
    `Open with one short Japanese line —「今日は、選んだ画像について自分の言葉で話す練習です」— then, ` +
    `in simple English, say in one sentence what you see in the picture so the learner knows you can ` +
    `see it. Then ask them to tell you about it for about a minute: what it is, what they did, what ` +
    `was hard, and what comes next (the points are on their screen). Say that you will listen to the ` +
    `end, and that they can press the hint button if they get stuck. Then stop and wait.`
  );
}

/** 改善点を伝えて話し直しを促す(now で送る)。 */
export function retellReviewNudge(analysis: TellingAnalysis): string {
  const items = analysis.improvements
    .map(
      (imp, i) =>
        `改善点${i + 1}: 学習者は「${imp.original}」と言った → 自然な言い方は "${imp.better}"。` +
        (imp.note ? `(${imp.note})` : ""),
    )
    .join("\n");
  const body =
    analysis.improvements.length > 0
      ? `改善点は次の通り。\n${items}\nそれぞれ、学習者の言い方を短く引き、理由を日本語で一言説明してから、自然な言い方をゆっくり一度言う。` +
        `意味も語彙のレベルも学習者のまま。文は画面に出ているので、ツールは呼ばず、画面のことも言わない。`
      : "直すべき点は見つからなかった。伝わった内容を一言でほめる。";
  return (
    `1回目の説明が終わり、内容の整理ができた。例文と促しは英語、訂正の理由は短い日本語で話すこと。まず一言、内容が伝わったことを伝える。` +
    `${body}` +
    (analysis.teaching?.collocation
      ? `再利用できる表現 "${analysis.teaching.collocation.phrase}" (${analysis.teaching.collocation.meaning}) を短く強調する。`
      : "") +
    `最後に「Now tell me the whole story again — this time with only the picture and the keywords.」と促して、黙って待つ。`
  );
}

/** Flash の分析が使えないとき、先生が自分で改善点を選ぶ(now で送る)。 */
export const RETELL_FALLBACK_REVIEW_NUDGE =
  "1回目の説明が終わった。自分が聞いた内容から、学習者の意図と語彙のレベルを保ったまま、改善点を1つか2つ選ぶこと。" +
  "それぞれ「あなたはこう言った → こう言える」を英語で声に出し、自然な言い方を show_term_card でカードに出す。" +
  "最後に「Now tell me the whole story again — this time with only the picture and the keywords.」と促して、黙って待つ。";

/** 2回目(話し直し)の直前に文脈に足す(next-turn で送る)。 */
export function retellRetellNudge(question: string): string {
  return (
    `学習者はこれから同じ内容をもう一度話す(2回目)。送信まで黙って聞き、途中で訂正しない。` +
    `終わったら、1回目より良くなった点を一言、直すなら一点だけ短く。` +
    `そのあと追加の質問として "${question}" を尋ね、黙って待つ。`
  );
}

/** 追加の質問の答えの直前に文脈に足す(next-turn で送る)。 */
export const RETELL_ANSWER_NUDGE =
  "次に届く発話は追加の質問への答え。一文で反応し、今日よかった点を一言で伝えて締めること。" +
  "次の課題は無いので、新しい質問はしない。";

/** 学習者が「ヒント」を押した(now で送る)。 */
export const RETELL_HINT_NUDGE =
  "学習者が詰まってヒントを求めた。話はまだ途中なので、講評も訂正もしない。ここまで聞いた内容から" +
  "(直前に日本語で言った語があればその英語を)、次に言えそうな2〜5語の英語のかたまりを1つだけ言い、" +
  "show_term_card でカードに出して、すぐ黙って続きを待つこと。";

/** 分析が長引いている(now で送る)。 */
export const RETELL_FILLER_NUDGE =
  "内容の整理にもう少し時間がかかっている。英語で「Just a moment.」くらいの一言だけ言い、黙ること。講評はまだ始めない。";

// ── 話し直し: Flash への依頼 ───────────────────────────────────────────────────

/** 1回目の説明の整理。画像と録音と一緒に渡す。 */
export function tellingAnalysisPrompt(prompts: readonly string[], transcriptHint: string): string {
  return `${RETELL_REVIEW_GUIDE}

The learner was offered these angles on screen: ${prompts.join(" / ")}.
Rough live transcript (may be wrong or incomplete; trust the recording over it):
"${transcriptHint || "(none)"}"

Listen to the recording and look at the picture, then return JSON with:
- transcript: what the learner actually said, cleaned only of false starts and fillers. Japanese
  words stay in Japanese.
- points: the points they conveyed, as short Japanese labels, two to five.
- improvements: zero to two, each with original (what they said, or reached for), better (the
  natural version at their level) and note (one short Japanese pointer on what changed).
- keywords: three to six short English cues for the second telling, in story order.
- question: one follow-up question in English.
- assessment: the four rubric dimensions, each with criterion, score (1-5 or null),
  evidence (exact quote from your returned transcript, corrected against the recording), and a specific Japanese reason.
- teaching: alternative {phrase, usage}, collocation {phrase, meaning, example}, and
  practice. Use common, topic-relevant expressions; omit an extension if not useful.`;
}

/** 2回目(話し直し)の振り返り。1回目の整理と一緒に渡す。 */
export function retellComparePrompt(first: TellingAnalysis, transcriptHint: string): string {
  const offered =
    first.improvements.length > 0
      ? first.improvements.map((imp, i) => `${i + 1}. "${imp.better}"`).join("\n")
      : "(none)";
  return `${RETELL_REVIEW_GUIDE}

This is the SECOND telling of the same picture, after the review.
First telling, transcript: "${first.transcript}"
Points conveyed the first time: ${first.points.join(" / ") || "(none)"}
First assessment (use the same rubric, but assess the new evidence independently):
${JSON.stringify(first.assessment ?? [])}
Natural versions offered after the first telling:
${offered}
Rough live transcript of the second telling (may be wrong or incomplete; trust the recording):
"${transcriptHint || "(none)"}"

Listen to the recording and return JSON with:
- transcript: what the learner said this time, cleaned only of false starts and fillers.
- points: the points conveyed this time, as short Japanese labels; where the same point is made,
  reuse the first-time wording.
- used: the offered natural versions whose target grammar/construction the learner used CORRECTLY
  in context this time, copied exactly from the list above. A valid paraphrase may count only if
  it demonstrates the same correction. An attempted but still incorrect construction, shared
  keywords, or a different correct construction does not count. Empty if none.
- comment: one line in Japanese: what got better, and one thing to keep working on.
- assessment: all four rubric dimensions with score (1-5 or null), evidence quoted
  from THIS telling's transcript, and a specific Japanese reason.`;
}

// ── ボード(whiteboard モード) ──────────────────────────────────────────────────

/** ボードだけのツール。TOOL_DIRECTIVE の後ろに付く。 */
export const WHITEBOARD_TOOL_DIRECTIVE = `

In this session you have show_recast, show_term_card and hide_card. show_recast puts the
learner's sentence next to your better version — call it every time you rephrase what they said,
with kind, a specific Japanese reason, and the alternative/collocation fields when useful. Use
show_term_card for a word or phrase you supply that they did not attempt. Both are silent: never
say that anything is on screen. There is no tool for drawing; you cannot mark the board.`;

export function whiteboardGreeting(): string {
  return (
    `Open with one short Japanese line —「今日はボードに描きながら話す練習です」— then, in simple ` +
    `English, invite the learner to draw anything they want to talk about: a system they are ` +
    `building, today's plan, a map of their morning. Say you will look at the board and ask about ` +
    `it, and that they can talk while drawing. Ask what they will draw first. Then stop and wait.`
  );
}
