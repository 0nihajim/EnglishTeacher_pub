/**
 * 言い直しの語単位の差分。「あなたの文 → 表現を使った文」で、消えた語と増えた語だけを
 * 目立たせるために使う。LCS(最長共通部分列)で語を突き合わせ、比較は小文字化して
 * 前後の句読点を落とした形で行う。表示は元の綴りのまま。
 *
 * 差分は学習の手がかりであって採点ではない。語順の入れ替えは「消えて増えた」と出るが、
 * それで十分(何が変わったかは伝わる)。
 */

export type DiffOp = "same" | "removed" | "added";

export interface DiffToken {
  /** 元の綴り(表示用)。 */
  text: string;
  op: DiffOp;
}

export interface WordDiff {
  /** 学習者の文。same と removed だけ。 */
  original: DiffToken[];
  /** 言い直し。same と added だけ。 */
  better: DiffToken[];
}

/** 比較用の形。大文字小文字と前後の句読点は無視し、アポストロフィの種類も揃える。 */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
}

export function tokenize(sentence: string): string[] {
  return sentence.split(/\s+/).filter((w) => w.length > 0);
}

export function wordDiff(original: string, better: string): WordDiff {
  const a = tokenize(original);
  const b = tokenize(better);
  const ka = a.map(normalizeWord);
  const kb = b.map(normalizeWord);

  // LCS 表。文は短い(数十語)ので O(n·m) で足りる。
  const n = ka.length;
  const m = kb.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = ka[i] === kb[j] && ka[i] !== "" ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const outA: DiffToken[] = [];
  const outB: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j] && ka[i] !== "") {
      outA.push({ text: a[i]!, op: "same" });
      outB.push({ text: b[j]!, op: "same" });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      outA.push({ text: a[i]!, op: "removed" });
      i++;
    } else {
      outB.push({ text: b[j]!, op: "added" });
      j++;
    }
  }
  while (i < n) outA.push({ text: a[i++]!, op: "removed" });
  while (j < m) outB.push({ text: b[j++]!, op: "added" });
  return { original: outA, better: outB };
}

/**
 * 学習者の発話が言い直しの文を「言えた」と見なせるか。増えた語(added)のうち、
 * 発話に含まれる割合で判定する。増えた語が無ければ文全体の語で見る。
 * 文字起こしの照合なので、目標表現の heard と同じ強さの根拠でしかない。
 */
export function saidBetter(utterance: string, diff: WordDiff, threshold = 0.7): boolean {
  const said = new Set(tokenize(utterance).map(normalizeWord).filter(Boolean));
  const added = diff.better.filter((t) => t.op === "added").map((t) => normalizeWord(t.text)).filter(Boolean);
  const keys = added.length > 0 ? added : diff.better.map((t) => normalizeWord(t.text)).filter(Boolean);
  if (keys.length === 0) return false;
  const hit = keys.filter((k) => said.has(k)).length;
  return hit / keys.length >= threshold;
}
