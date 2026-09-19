/**
 * 文字起こしと表現の照合。文字起こしには句読点も大文字小文字の揺れもあるので、
 * 両方を同じ形に潰してから比べる。
 */

/** 比較用に正規化する。英数字以外は空白にし、空白を1つにまとめる。 */
export function normalizeTerm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 文の中にその表現(または別形)が入っているか。単語の境界で見るので、
 * "roll out" は "payroll outage" に反応しない。
 */
export function mentions(text: string, term: string, variants: readonly string[] = []): boolean {
  const said = ` ${normalizeTerm(text)} `;
  return [term, ...variants].some((t) => {
    const key = normalizeTerm(t);
    return key.length > 0 && said.includes(` ${key} `);
  });
}
