import type { Glossary, Issue, ResolvedLanguage, ScanLanguage, TextReplacement, TextTarget } from "./models";
import type { CorrectionEngine } from "./correctionEngineAdapter";
import { applyReplacement, makeIssueId } from "./textEdits";

interface RuleMatch {
  type: Issue["type"];
  severity: Issue["severity"];
  ruleId: string;
  message: string;
  replacement: TextReplacement;
}

const englishSpellingRules: Array<{ pattern: RegExp; replacement: string; message: string; id: string }> = [
  { pattern: /\bteh\b/gi, replacement: "the", message: "Possible misspelling: “teh”.", id: "spell-teh" },
  { pattern: /\bpremier\s+pro\b/gi, replacement: "Premiere Pro", message: "Possible product name typo: “premier pro”.", id: "spell-premier-pro" },
  { pattern: /\bcheckk\b/gi, replacement: "check", message: "Possible misspelling: “checkk”.", id: "spell-checkk" },
  { pattern: /\btets\b/gi, replacement: "test", message: "Possible misspelling: “tets”.", id: "spell-tets" },
  { pattern: /\bd\s+ouble\b/gi, replacement: "double", message: "Possible split word: “d ouble”.", id: "spell-d-ouble" },
  { pattern: /\bPremiere pro\b/g, replacement: "Premiere Pro", message: "Capitalize the product name as “Premiere Pro”.", id: "spell-premiere-pro-case" },
  { pattern: /\brecieve\b/gi, replacement: "receive", message: "Possible misspelling: “recieve”.", id: "spell-recieve" },
  { pattern: /\bseperate\b/gi, replacement: "separate", message: "Possible misspelling: “seperate”.", id: "spell-seperate" },
  { pattern: /\bdefinately\b/gi, replacement: "definitely", message: "Possible misspelling: “definately”.", id: "spell-definately" },
  { pattern: /\boccured\b/gi, replacement: "occurred", message: "Possible misspelling: “occured”.", id: "spell-occurred" }
];

const germanSpellingRules: Array<{ pattern: RegExp; replacement: string; message: string; id: string }> = [
  { pattern: /\bd\s+ouble\b/gi, replacement: "double", message: "Mögliche Trennung: „d ouble“.", id: "spell-d-ouble" },
  { pattern: /\bpremier\s+pro\b/gi, replacement: "Premiere Pro", message: "Möglicher Produktname: „Premiere Pro“.", id: "spell-premier-pro" },
  { pattern: /\bcheckk\b/gi, replacement: "Check", message: "Möglicher Schreibfehler: „Checkk“.", id: "spell-checkk" },
  { pattern: /\bbestimt\b/gi, replacement: "bestimmt", message: "Möglicher Schreibfehler: „bestimt“.", id: "spell-bestimt" },
  { pattern: /\bnichtt\b/gi, replacement: "nicht", message: "Möglicher Schreibfehler: „nichtt“.", id: "spell-nichtt" },
  { pattern: /\bnet\b/g, replacement: "nicht", message: "Möglicher Schreibfehler: „net“.", id: "spell-net" },
  { pattern: /\bgautingen\b/gi, replacement: "Gauting", message: "Möglicher Ortsname: „Gauting“ statt „Gautingen“.", id: "spell-gautingen" },
  { pattern: /\bheist\b/gi, replacement: "heißt", message: "Möglicher Schreibfehler: „heist“.", id: "spell-heist" },
  { pattern: /\bdasss\b/gi, replacement: "dass", message: "Möglicher Schreibfehler: „dasss“.", id: "spell-dasss" },
  { pattern: /\bzumindestens\b/gi, replacement: "zumindest", message: "Möglicher Schreibfehler: „zumindestens“.", id: "spell-zumindestens" },
  { pattern: /\bPremiere pro\b/g, replacement: "Premiere Pro", message: "Produktname als „Premiere Pro“ schreiben.", id: "spell-premiere-pro-case" }
];

export class MockCorrectionEngine implements CorrectionEngine {
  checkTargets(targets: TextTarget[], glossary: Glossary, language: ScanLanguage): Issue[] {
    return targets.flatMap((target) => this.checkTarget(target, glossary, language));
  }

  private checkTarget(target: TextTarget, glossary: Glossary, language: ScanLanguage): Issue[] {
    const resolvedLanguages = resolveLanguages(target.originalText, language);
    const matches = resolvedLanguages.flatMap((resolvedLanguage) => [
      ...findSpelling(target.originalText, resolvedLanguage),
      ...findPunctuation(target.originalText, resolvedLanguage),
      ...findGrammar(target.originalText, resolvedLanguage),
      ...findGlossary(target.originalText, glossary, resolvedLanguage)
    ]);

    const seen = new Set<string>();
    return matches
      .filter((match) => {
        const key = `${match.replacement.start}:${match.replacement.end}:${match.replacement.replacement}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .map((match) => ({
        id: makeIssueId(target.id, match.ruleId, match.replacement.start, match.replacement.end),
        targetId: target.id,
        type: match.type,
        severity: match.severity,
        ruleId: match.ruleId,
        message: match.message,
        originalText: target.originalText,
        suggestedText: applyReplacement(target.originalText, match.replacement),
        replacement: match.replacement,
        status: "pending",
        target
      }));
  }
}

function findSpelling(text: string, language: ResolvedLanguage): RuleMatch[] {
  const rules = language === "de" ? germanSpellingRules : englishSpellingRules;
  return rules.flatMap((rule) => {
    const matches: RuleMatch[] = [];
    for (const match of text.matchAll(rule.pattern)) {
      const found = match[0];
      const start = match.index ?? 0;
      matches.push({
        type: "spelling",
        severity: "warning",
        ruleId: rule.id,
        message: rule.message,
        replacement: {
          start,
          end: start + found.length,
          replacement: matchCase(found, rule.replacement)
        }
      });
    }
    return matches;
  });
}

function findPunctuation(text: string, language: ResolvedLanguage): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const match of text.matchAll(/ {2,}/g)) {
    const start = match.index ?? 0;
    matches.push({
      type: "punctuation",
      severity: "info",
      ruleId: "punctuation-double-space",
      message: language === "de" ? "Doppelte Leerzeichen entfernen." : "Remove repeated spaces.",
      replacement: { start, end: start + match[0].length, replacement: " " }
    });
  }

  for (const match of text.matchAll(/\s+([,.;:!?])/g)) {
    const start = match.index ?? 0;
    matches.push({
      type: "punctuation",
      severity: "info",
      ruleId: "punctuation-space-before-mark",
      message: language === "de" ? "Leerzeichen vor Satzzeichen entfernen." : "Remove the space before punctuation.",
      replacement: { start, end: start + match[0].length, replacement: match[1] }
    });
  }

  for (const match of text.matchAll(/([,;:!?])(?=\S)/g)) {
    const start = match.index ?? 0;
    const mark = match[1];
    const nextChar = text[start + 1] ?? "";
    const previousChar = text[start - 1] ?? "";
    if (mark === "," && /\d/.test(previousChar) && /\d/.test(nextChar)) {
      continue;
    }
    matches.push({
      type: "punctuation",
      severity: "info",
      ruleId: "punctuation-missing-space-after-mark",
      message: language === "de" ? "Leerzeichen nach Satzzeichen ergänzen." : "Add a space after punctuation.",
      replacement: { start, end: start + 1, replacement: `${mark} ` }
    });
  }

  for (const match of text.matchAll(/\s-\s(?=[A-Za-zÄÖÜäöüß])/g)) {
    const start = match.index ?? 0;
    const previousChar = text[start - 1] ?? "";
    const nextChar = text[start + match[0].length] ?? "";
    if (!/[A-Za-zÄÖÜäöüß]/.test(previousChar) || !/[A-Za-zÄÖÜäöüß]/.test(nextChar)) {
      continue;
    }
    matches.push({
      type: "punctuation",
      severity: "info",
      ruleId: "punctuation-space-hyphen-space",
      message: language === "de" ? "Unnötigen Gedankenstrich entfernen." : "Remove unnecessary mid-phrase dash.",
      replacement: { start, end: start + match[0].length, replacement: " " }
    });
  }

  const trimmed = text.trimEnd();
  if (trimmed.length > 18 && /[A-Za-z0-9)]$/.test(trimmed)) {
    matches.push({
      type: "punctuation",
      severity: "info",
      ruleId: "punctuation-terminal-mark",
      message: language === "de" ? "Abschließendes Satzzeichen ergänzen." : "Consider adding terminal punctuation.",
      replacement: { start: trimmed.length, end: trimmed.length, replacement: "." }
    });
  }

  return matches;
}

function findGrammar(text: string, language: ResolvedLanguage): RuleMatch[] {
  if (language === "de") {
    return findGermanGrammar(text);
  }

  return findEnglishGrammar(text);
}

function findEnglishGrammar(text: string): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const match of text.matchAll(/\b[Dd]ont\b/g)) {
    const start = match.index ?? 0;
    matches.push({
      type: "grammar",
      severity: "warning",
      ruleId: "grammar-dont-apostrophe",
      message: "Use an apostrophe in “don’t”.",
      replacement: {
        start,
        end: start + match[0].length,
        replacement: match[0][0] === "D" ? "Don’t" : "don’t"
      }
    });
  }

  for (const match of text.matchAll(/\b[Ii]ts\s+(?=(?:a|an|the|not|going|time|important|ready)\b)/g)) {
    const start = match.index ?? 0;
    matches.push({
      type: "grammar",
      severity: "warning",
      ruleId: "grammar-its-contraction",
      message: "This looks like the contraction “it’s”.",
      replacement: {
        start,
        end: start + 3,
        replacement: match[0][0] === "I" ? "It’s" : "it’s"
      }
    });
  }

  return matches;
}

function findGermanGrammar(text: string): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const match of text.matchAll(/\bsind sie\b/g)) {
    const start = match.index ?? 0;
    matches.push({
      type: "grammar",
      severity: "warning",
      ruleId: "grammar-sie-capitalized",
      message: "In formeller Anrede wird „Sie“ großgeschrieben.",
      replacement: { start, end: start + match[0].length, replacement: "sind Sie" }
    });
  }

  for (const match of text.matchAll(/\bder\s+best\s+(?=[A-Za-zÄÖÜäöüß])/gi)) {
    const start = match.index ?? 0;
    matches.push({
      type: "grammar",
      severity: "warning",
      ruleId: "grammar-der-best",
      message: "Hier passt meist „der beste …“.",
      replacement: { start, end: start + match[0].length, replacement: "der beste " }
    });
  }

  for (const match of text.matchAll(/\bbest\s+check\b/gi)) {
    const start = match.index ?? 0;
    const found = match[0];
    const leading = found[0] === found[0]?.toUpperCase() ? "Beste" : "beste";
    matches.push({
      type: "grammar",
      severity: "warning",
      ruleId: "grammar-best-check",
      message: "Hier passt meist „beste Check“.",
      replacement: { start, end: start + found.length, replacement: `${leading} Check` }
    });
  }

  for (const match of text.matchAll(/\bbeste\s+heck\b/gi)) {
    const start = match.index ?? 0;
    matches.push({
      type: "spelling",
      severity: "warning",
      ruleId: "spell-beste-heck",
      message: "Wahrscheinlich „beste Check“ statt „beste heck“.",
      replacement: { start, end: start + match[0].length, replacement: "beste Check" }
    });
  }

  for (const match of text.matchAll(/\bbestimmt,\s*nicht\b/gi)) {
    const start = match.index ?? 0;
    const found = match[0];
    matches.push({
      type: "grammar",
      severity: "warning",
      ruleId: "grammar-bestimmt-nicht",
      message: "Hier passt meist „bestimmt nicht“ ohne Komma.",
      replacement: { start, end: start + found.length, replacement: "bestimmt nicht" }
    });
  }

  return matches;
}

function findGlossary(text: string, glossary: Glossary, language: ResolvedLanguage): RuleMatch[] {
  return glossary.brandTerms.flatMap((term) => {
    if (term.language && term.language !== language) {
      return [];
    }

    const escaped = escapeRegExp(term.term);
    const flags = term.caseSensitive ? "g" : "gi";
    const pattern = new RegExp(`\\b${escaped}\\b`, flags);
    const matches: RuleMatch[] = [];

    for (const match of text.matchAll(pattern)) {
      if (match[0] === term.preferred) {
        continue;
      }
      const start = match.index ?? 0;
      matches.push({
        type: "glossary",
        severity: "error",
        ruleId: `glossary-${term.term.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        message: term.note ? `${term.note}: use “${term.preferred}”.` : `Use brand term “${term.preferred}”.`,
        replacement: { start, end: start + match[0].length, replacement: term.preferred }
      });
    }

    return matches;
  });
}

function resolveLanguage(text: string, selected: ScanLanguage): ResolvedLanguage {
  if (selected === "en" || selected === "de") {
    return selected;
  }

  const sample = text.toLowerCase();
  let germanScore = 0;
  let englishScore = 0;

  if (/[äöüß]/i.test(sample)) {
    germanScore += 3;
  }
  if (/\b(der|die|das|und|nicht|mit|ist|sind|wir|ihr|für|auch)\b/.test(sample)) {
    germanScore += 2;
  }
  if (/\b(the|and|not|with|is|are|we|you|for|also|this|that)\b/.test(sample)) {
    englishScore += 2;
  }
  if (/\b(don't|it's|we're|they're)\b/.test(sample)) {
    englishScore += 3;
  }

  return germanScore > englishScore ? "de" : "en";
}

function resolveLanguages(text: string, selected: ScanLanguage): ResolvedLanguage[] {
  if (selected === "de" || selected === "en") {
    return [selected];
  }

  const sample = text.toLowerCase();
  const germanSignals =
    (/[äöüß]/i.test(sample) ? 3 : 0) + (/\b(der|die|das|und|nicht|mit|ist|sind|wir|ihr|für|auch)\b/.test(sample) ? 2 : 0);
  const englishSignals =
    (/\b(the|and|not|with|is|are|we|you|for|also|this|that)\b/.test(sample) ? 2 : 0) +
    (/\b(don't|dont|it's|we're|they're)\b/.test(sample) ? 3 : 0);

  if (germanSignals >= 2 && englishSignals >= 2) {
    return ["de", "en"];
  }

  return [resolveLanguage(text, selected)];
}

function matchCase(found: string, replacement: string): string {
  if (found.toUpperCase() === found) {
    return replacement.toUpperCase();
  }
  if (found[0]?.toUpperCase() === found[0]) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
