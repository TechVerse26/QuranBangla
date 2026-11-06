// ---------- Approximate Tajweed color highlighting ----------
// IMPORTANT: this is a simplified, rule-of-thumb, client-side highlighter
// meant purely as a casual visual learning aid. It is NOT built from a
// certified/scholar-reviewed tajweed-annotated mushaf text (like Tajweed
// Qaida editions use) — it just pattern-matches a handful of the most
// common rules against the plain Uthmani text. It WILL miss cases and can
// occasionally mis-highlight. For serious tajweed study, always cross-check
// with a certified tajweed mushaf or qualified teacher.
//
// Rules covered (deliberately kept to the most recognizable ones):
//   - Qalqalah letters (ق ط ب ج د) carrying sukun
//   - Ghunnah: noon/meem with shaddah
//   - Noon sakinah / tanween marks
//   - Common madd (elongation) letter patterns
//
// Matches are tokenized before substitution so the four rules below never
// re-match text a previous rule already wrapped in a <span>.

const TAJWEED_RULES = [
  { cls: 'tj-qalqalah', regex: /[قطبجد]ْ/g },
  { cls: 'tj-ghunnah',  regex: /[نم]ّ/g },
  { cls: 'tj-noon',     regex: /(نْ|ًٌٍ|ً|ٌ|ٍ)/g },
  { cls: 'tj-madd',     regex: /(آ|َا|ُو|ِي)/g }
];

function tajweedHighlight(arabicText){
  if(!state.tajweedMode || !arabicText) return arabicText;
  const tokens = [];
  let text = arabicText;
  TAJWEED_RULES.forEach(rule => {
    text = text.replace(rule.regex, (m) => {
      tokens.push(`<span class="${rule.cls}">${m}</span>`);
      return `\u0001${tokens.length - 1}\u0001`;
    });
  });
  return text.replace(/\u0001(\d+)\u0001/g, (_, idx) => tokens[Number(idx)]);
}
