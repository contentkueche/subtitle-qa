/* Subtitle QA - Adobe Premiere Pro UXP panel bundle */
"use strict";
(() => {
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });

  // src/domain/logger.ts
  var Logger = class {
    constructor() {
      this.entries = [];
      this.listeners = /* @__PURE__ */ new Set();
    }
    onChange(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    debug(message, data) {
      this.add("debug", message, data);
    }
    info(message, data) {
      this.add("info", message, data);
    }
    warn(message, data) {
      this.add("warn", message, data);
    }
    error(message, data) {
      this.add("error", message, data);
    }
    clear() {
      this.entries = [];
      this.emit();
    }
    all() {
      return [...this.entries];
    }
    toText() {
      return this.entries.map((entry) => {
        const data = entry.data === void 0 ? "" : `
${safeJson(entry.data)}`;
        return `[${entry.at}] ${entry.level.toUpperCase()} ${entry.message}${data}`;
      }).join("\n\n");
    }
    add(level, message, data) {
      this.entries.push({ at: (/* @__PURE__ */ new Date()).toISOString(), level, message, data });
      this.emit();
    }
    emit() {
      for (const listener of this.listeners) {
        listener();
      }
    }
  };
  function safeJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  // src/domain/glossary.ts
  var defaultGlossary = {
    brandTerms: [
      {
        term: "premier pro",
        preferred: "Premiere Pro",
        caseSensitive: false,
        note: "Adobe product spelling"
      },
      {
        term: "premiere pro",
        preferred: "Premiere Pro",
        caseSensitive: false,
        note: "Adobe product capitalization"
      },
      {
        term: "adobe premier",
        preferred: "Adobe Premiere Pro",
        caseSensitive: false,
        note: "Use full product name"
      }
    ]
  };
  function parseGlossaryJson(raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.brandTerms)) {
      throw new Error("Glossary JSON must contain a brandTerms array.");
    }
    return {
      brandTerms: parsed.brandTerms.map((entry, index) => {
        if (!entry || typeof entry.term !== "string" || typeof entry.preferred !== "string") {
          throw new Error(`Glossary entry ${index + 1} must include term and preferred strings.`);
        }
        if (entry.language !== void 0 && entry.language !== "de" && entry.language !== "en") {
          throw new Error(`Glossary entry ${index + 1} language must be "de" or "en" when provided.`);
        }
        return {
          term: entry.term,
          preferred: entry.preferred,
          language: entry.language,
          caseSensitive: Boolean(entry.caseSensitive),
          note: typeof entry.note === "string" ? entry.note : void 0
        };
      })
    };
  }

  // src/domain/textEdits.ts
  function applyReplacement(text, replacement) {
    return text.slice(0, replacement.start) + replacement.replacement + text.slice(replacement.end);
  }
  function applyIssueSet(original, issues) {
    const dedupedIssues = dedupeIssuesByReplacement(issues);
    const selectedIssues = selectNonOverlappingIssues(dedupedIssues);
    const replacements = selectedIssues.map((issue) => issue.replacement).sort((a, b) => b.start - a.start || b.end - a.end);
    return replacements.reduce((current, replacement) => applyReplacement(current, replacement), original);
  }
  function makeIssueId(targetId, ruleId, start, end) {
    return `${targetId}:${ruleId}:${start}:${end}`;
  }
  function dedupeIssuesByReplacement(issues) {
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const issue of issues) {
      const replacement = issue.replacement;
      const key = `${replacement.start}:${replacement.end}:${replacement.replacement}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(issue);
      }
    }
    return result;
  }
  function selectNonOverlappingIssues(issues) {
    const sorted = [...issues].sort((left, right) => {
      const leftSpan = left.replacement.end - left.replacement.start;
      const rightSpan = right.replacement.end - right.replacement.start;
      if (rightSpan !== leftSpan) {
        return rightSpan - leftSpan;
      }
      const typeScoreDiff = issueTypeScore(right) - issueTypeScore(left);
      if (typeScoreDiff !== 0) {
        return typeScoreDiff;
      }
      if (left.replacement.start !== right.replacement.start) {
        return left.replacement.start - right.replacement.start;
      }
      return left.replacement.end - right.replacement.end;
    });
    const selected = [];
    for (const candidate of sorted) {
      const overlapsSelected = selected.some((existing) => rangesOverlap(existing.replacement, candidate.replacement));
      if (!overlapsSelected) {
        selected.push(candidate);
      }
    }
    return selected;
  }
  function rangesOverlap(left, right) {
    return left.start < right.end && right.start < left.end;
  }
  function issueTypeScore(issue) {
    if (issue.type === "glossary") {
      return 4;
    }
    if (issue.type === "grammar") {
      return 3;
    }
    if (issue.type === "spelling") {
      return 2;
    }
    if (issue.type === "punctuation") {
      return 1;
    }
    return 0;
  }

  // src/domain/mockCorrectionEngine.ts
  var englishSpellingRules = [
    { pattern: /\bteh\b/gi, replacement: "the", message: "Possible misspelling: \u201Cteh\u201D.", id: "spell-teh" },
    { pattern: /\bpremier\s+pro\b/gi, replacement: "Premiere Pro", message: "Possible product name typo: \u201Cpremier pro\u201D.", id: "spell-premier-pro" },
    { pattern: /\bcheckk\b/gi, replacement: "check", message: "Possible misspelling: \u201Ccheckk\u201D.", id: "spell-checkk" },
    { pattern: /\btets\b/gi, replacement: "test", message: "Possible misspelling: \u201Ctets\u201D.", id: "spell-tets" },
    { pattern: /\bd\s+ouble\b/gi, replacement: "double", message: "Possible split word: \u201Cd ouble\u201D.", id: "spell-d-ouble" },
    { pattern: /\bPremiere pro\b/g, replacement: "Premiere Pro", message: "Capitalize the product name as \u201CPremiere Pro\u201D.", id: "spell-premiere-pro-case" },
    { pattern: /\brecieve\b/gi, replacement: "receive", message: "Possible misspelling: \u201Crecieve\u201D.", id: "spell-recieve" },
    { pattern: /\bseperate\b/gi, replacement: "separate", message: "Possible misspelling: \u201Cseperate\u201D.", id: "spell-seperate" },
    { pattern: /\bdefinately\b/gi, replacement: "definitely", message: "Possible misspelling: \u201Cdefinately\u201D.", id: "spell-definately" },
    { pattern: /\boccured\b/gi, replacement: "occurred", message: "Possible misspelling: \u201Coccured\u201D.", id: "spell-occurred" }
  ];
  var germanSpellingRules = [
    { pattern: /\bd\s+ouble\b/gi, replacement: "double", message: "M\xF6gliche Trennung: \u201Ed ouble\u201C.", id: "spell-d-ouble" },
    { pattern: /\bpremier\s+pro\b/gi, replacement: "Premiere Pro", message: "M\xF6glicher Produktname: \u201EPremiere Pro\u201C.", id: "spell-premier-pro" },
    { pattern: /\bcheckk\b/gi, replacement: "Check", message: "M\xF6glicher Schreibfehler: \u201ECheckk\u201C.", id: "spell-checkk" },
    { pattern: /\bbestimt\b/gi, replacement: "bestimmt", message: "M\xF6glicher Schreibfehler: \u201Ebestimt\u201C.", id: "spell-bestimt" },
    { pattern: /\bnichtt\b/gi, replacement: "nicht", message: "M\xF6glicher Schreibfehler: \u201Enichtt\u201C.", id: "spell-nichtt" },
    { pattern: /\bnet\b/g, replacement: "nicht", message: "M\xF6glicher Schreibfehler: \u201Enet\u201C.", id: "spell-net" },
    { pattern: /\bgautingen\b/gi, replacement: "Gauting", message: "M\xF6glicher Ortsname: \u201EGauting\u201C statt \u201EGautingen\u201C.", id: "spell-gautingen" },
    { pattern: /\bheist\b/gi, replacement: "hei\xDFt", message: "M\xF6glicher Schreibfehler: \u201Eheist\u201C.", id: "spell-heist" },
    { pattern: /\bdasss\b/gi, replacement: "dass", message: "M\xF6glicher Schreibfehler: \u201Edasss\u201C.", id: "spell-dasss" },
    { pattern: /\bzumindestens\b/gi, replacement: "zumindest", message: "M\xF6glicher Schreibfehler: \u201Ezumindestens\u201C.", id: "spell-zumindestens" },
    { pattern: /\bPremiere pro\b/g, replacement: "Premiere Pro", message: "Produktname als \u201EPremiere Pro\u201C schreiben.", id: "spell-premiere-pro-case" }
  ];
  var MockCorrectionEngine = class {
    checkTargets(targets, glossary, language) {
      return targets.flatMap((target) => this.checkTarget(target, glossary, language));
    }
    checkTarget(target, glossary, language) {
      const resolvedLanguages = resolveLanguages(target.originalText, language);
      const matches = resolvedLanguages.flatMap((resolvedLanguage) => [
        ...findSpelling(target.originalText, resolvedLanguage),
        ...findPunctuation(target.originalText, resolvedLanguage),
        ...findGrammar(target.originalText, resolvedLanguage),
        ...findGlossary(target.originalText, glossary, resolvedLanguage)
      ]);
      const seen = /* @__PURE__ */ new Set();
      return matches.filter((match) => {
        const key = `${match.replacement.start}:${match.replacement.end}:${match.replacement.replacement}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      }).map((match) => ({
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
  };
  function findSpelling(text, language) {
    const rules = language === "de" ? germanSpellingRules : englishSpellingRules;
    return rules.flatMap((rule) => {
      const matches = [];
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
  function findPunctuation(text, language) {
    const matches = [];
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
        message: language === "de" ? "Leerzeichen nach Satzzeichen erg\xE4nzen." : "Add a space after punctuation.",
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
        message: language === "de" ? "Unn\xF6tigen Gedankenstrich entfernen." : "Remove unnecessary mid-phrase dash.",
        replacement: { start, end: start + match[0].length, replacement: " " }
      });
    }
    const trimmed = text.trimEnd();
    if (trimmed.length > 18 && /[A-Za-z0-9)]$/.test(trimmed)) {
      matches.push({
        type: "punctuation",
        severity: "info",
        ruleId: "punctuation-terminal-mark",
        message: language === "de" ? "Abschlie\xDFendes Satzzeichen erg\xE4nzen." : "Consider adding terminal punctuation.",
        replacement: { start: trimmed.length, end: trimmed.length, replacement: "." }
      });
    }
    return matches;
  }
  function findGrammar(text, language) {
    if (language === "de") {
      return findGermanGrammar(text);
    }
    return findEnglishGrammar(text);
  }
  function findEnglishGrammar(text) {
    const matches = [];
    for (const match of text.matchAll(/\b[Dd]ont\b/g)) {
      const start = match.index ?? 0;
      matches.push({
        type: "grammar",
        severity: "warning",
        ruleId: "grammar-dont-apostrophe",
        message: "Use an apostrophe in \u201Cdon\u2019t\u201D.",
        replacement: {
          start,
          end: start + match[0].length,
          replacement: match[0][0] === "D" ? "Don\u2019t" : "don\u2019t"
        }
      });
    }
    for (const match of text.matchAll(/\b[Ii]ts\s+(?=(?:a|an|the|not|going|time|important|ready)\b)/g)) {
      const start = match.index ?? 0;
      matches.push({
        type: "grammar",
        severity: "warning",
        ruleId: "grammar-its-contraction",
        message: "This looks like the contraction \u201Cit\u2019s\u201D.",
        replacement: {
          start,
          end: start + 3,
          replacement: match[0][0] === "I" ? "It\u2019s" : "it\u2019s"
        }
      });
    }
    return matches;
  }
  function findGermanGrammar(text) {
    const matches = [];
    for (const match of text.matchAll(/\bsind sie\b/g)) {
      const start = match.index ?? 0;
      matches.push({
        type: "grammar",
        severity: "warning",
        ruleId: "grammar-sie-capitalized",
        message: "In formeller Anrede wird \u201ESie\u201C gro\xDFgeschrieben.",
        replacement: { start, end: start + match[0].length, replacement: "sind Sie" }
      });
    }
    for (const match of text.matchAll(/\bder\s+best\s+(?=[A-Za-zÄÖÜäöüß])/gi)) {
      const start = match.index ?? 0;
      matches.push({
        type: "grammar",
        severity: "warning",
        ruleId: "grammar-der-best",
        message: "Hier passt meist \u201Eder beste \u2026\u201C.",
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
        message: "Hier passt meist \u201Ebeste Check\u201C.",
        replacement: { start, end: start + found.length, replacement: `${leading} Check` }
      });
    }
    for (const match of text.matchAll(/\bbeste\s+heck\b/gi)) {
      const start = match.index ?? 0;
      matches.push({
        type: "spelling",
        severity: "warning",
        ruleId: "spell-beste-heck",
        message: "Wahrscheinlich \u201Ebeste Check\u201C statt \u201Ebeste heck\u201C.",
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
        message: "Hier passt meist \u201Ebestimmt nicht\u201C ohne Komma.",
        replacement: { start, end: start + found.length, replacement: "bestimmt nicht" }
      });
    }
    return matches;
  }
  function findGlossary(text, glossary, language) {
    return glossary.brandTerms.flatMap((term) => {
      if (term.language && term.language !== language) {
        return [];
      }
      const escaped = escapeRegExp(term.term);
      const flags = term.caseSensitive ? "g" : "gi";
      const pattern = new RegExp(`\\b${escaped}\\b`, flags);
      const matches = [];
      for (const match of text.matchAll(pattern)) {
        if (match[0] === term.preferred) {
          continue;
        }
        const start = match.index ?? 0;
        matches.push({
          type: "glossary",
          severity: "error",
          ruleId: `glossary-${term.term.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          message: term.note ? `${term.note}: use \u201C${term.preferred}\u201D.` : `Use brand term \u201C${term.preferred}\u201D.`,
          replacement: { start, end: start + match[0].length, replacement: term.preferred }
        });
      }
      return matches;
    });
  }
  function resolveLanguage(text, selected) {
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
  function resolveLanguages(text, selected) {
    if (selected === "de" || selected === "en") {
      return [selected];
    }
    const sample = text.toLowerCase();
    const germanSignals = (/[äöüß]/i.test(sample) ? 3 : 0) + (/\b(der|die|das|und|nicht|mit|ist|sind|wir|ihr|für|auch)\b/.test(sample) ? 2 : 0);
    const englishSignals = (/\b(the|and|not|with|is|are|we|you|for|also|this|that)\b/.test(sample) ? 2 : 0) + (/\b(don't|dont|it's|we're|they're)\b/.test(sample) ? 3 : 0);
    if (germanSignals >= 2 && englishSignals >= 2) {
      return ["de", "en"];
    }
    return [resolveLanguage(text, selected)];
  }
  function matchCase(found, replacement) {
    if (found.toUpperCase() === found) {
      return replacement.toUpperCase();
    }
    if (found[0]?.toUpperCase() === found[0]) {
      return replacement[0].toUpperCase() + replacement.slice(1);
    }
    return replacement;
  }
  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // src/domain/openAiTranscriptCleanupEngine.ts
  var FULL_TRANSCRIPT_REWRITE_RULE_ID = "openai-transcript-rewrite";
  var OpenAiTranscriptCleanupEngine = class {
    constructor(endpoint = "https://api.openai.com/v1/responses", timeoutMs = 3e4) {
      this.endpoint = endpoint;
      this.timeoutMs = timeoutMs;
    }
    async cleanTargets(targets, language, settings, glossary) {
      const apiKey = settings.apiKey.trim();
      if (!apiKey) {
        throw new Error("Clean Transcript needs an OpenAI API key in Engine Settings.");
      }
      const model = settings.model.trim() || "gpt-4.1-mini";
      const responseJson = await this.postJson(buildRequestPayload(targets, language, model, glossary), apiKey);
      const parsed = parseCleanupResponse(responseJson);
      const mapped = new Map(parsed.corrections.map((item) => [item.id, item]));
      const issues = [];
      for (const target of targets) {
        const correction = mapped.get(target.id);
        if (!correction) {
          continue;
        }
        const corrected = normalizeReturnedTranscript(correction.corrected);
        const original = normalizeReturnedTranscript(target.originalText);
        if (!corrected || corrected === original || !isSafeTranscriptRewrite(original, corrected)) {
          continue;
        }
        issues.push({
          id: makeIssueId(target.id, FULL_TRANSCRIPT_REWRITE_RULE_ID, 0, target.originalText.length),
          targetId: target.id,
          type: "grammar",
          severity: "warning",
          ruleId: FULL_TRANSCRIPT_REWRITE_RULE_ID,
          message: correction.note.trim() || "Full transcript cleanup from OpenAI.",
          originalText: target.originalText,
          suggestedText: corrected,
          replacement: {
            start: 0,
            end: target.originalText.length,
            replacement: corrected
          },
          status: "pending",
          target
        });
      }
      return issues;
    }
    async postJson(payload, apiKey) {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : void 0;
      const timeout = controller ? setTimeout(() => {
        controller.abort();
      }, this.timeoutMs) : void 0;
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(payload),
          signal: controller?.signal
        });
        if (!response.ok) {
          let detail = "";
          try {
            const body = await response.text();
            detail = body ? ` ${body.slice(0, 400)}` : "";
          } catch {
          }
          throw new Error(`OpenAI transcript cleanup failed with HTTP ${response.status}.${detail}`);
        }
        return await response.json();
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    }
  };
  function buildRequestPayload(targets, language, model, glossary) {
    const languageMode = language === "de" ? "German" : language === "en" ? "English" : "Auto-detect per transcript segment (German or English)";
    const glossaryTerms = glossary.brandTerms.slice(0, 400).map((term) => ({
      term: term.term,
      preferred: term.preferred,
      language: term.language ?? "both",
      caseSensitive: term.caseSensitive ?? false,
      note: term.note ?? ""
    }));
    return {
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "You clean Adobe Premiere transcript segments before captions are generated.",
                "Correct spelling, grammar, punctuation, casing, repeated words, obvious ASR fragments, and broken spacing.",
                "Keep the speaker's meaning, tone, language, and order. Do not invent facts.",
                "Remove duplicated partial phrases only when they are clearly transcript artifacts.",
                "Do not summarize. Do not make marketing copy. Do not rewrite style beyond making the transcript correct and readable.",
                "For German, use natural written German punctuation and capitalization.",
                "For English, use natural written English punctuation and capitalization.",
                "Respect glossaryTerms exactly for brands, people, products, companies, and places.",
                "If a proper name is not in glossaryTerms and you are uncertain, leave it unchanged.",
                "Return one corrected text for every target id. Preserve paragraph breaks inside a target only if they are meaningful.",
                "If a target needs no change, return the original text unchanged."
              ].join(" ")
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                languageMode,
                glossaryTerms,
                targets: targets.map((target, index) => ({
                  id: target.id,
                  text: target.originalText,
                  previousSegment: index > 0 ? targets[index - 1].originalText : "",
                  nextSegment: index + 1 < targets.length ? targets[index + 1].originalText : ""
                }))
              })
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "subtitle_qa_transcript_cleanup_response",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              corrections: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    corrected: { type: "string" },
                    note: { type: "string" }
                  },
                  required: ["id", "corrected", "note"]
                }
              }
            },
            required: ["corrections"]
          },
          strict: true
        }
      }
    };
  }
  function parseCleanupResponse(raw) {
    const direct = raw?.output_text;
    if (typeof direct === "string" && direct.trim()) {
      return validateCleanupResponse(JSON.parse(direct));
    }
    if (Array.isArray(direct)) {
      const joined = direct.filter((part) => typeof part === "string").join("");
      if (joined.trim()) {
        return validateCleanupResponse(JSON.parse(joined));
      }
    }
    const output = Array.isArray(raw?.output) ? raw.output : [];
    const textParts = [];
    for (const item of output) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const block of content) {
        if (typeof block?.text === "string") {
          textParts.push(block.text);
        }
      }
    }
    const combined = textParts.join("");
    if (combined.trim()) {
      return validateCleanupResponse(JSON.parse(combined));
    }
    throw new Error("OpenAI response did not contain parsable JSON transcript cleanup output.");
  }
  function validateCleanupResponse(value) {
    if (!value || typeof value !== "object") {
      throw new Error("OpenAI transcript cleanup JSON is not an object.");
    }
    const corrections = value.corrections;
    if (!Array.isArray(corrections)) {
      throw new Error("OpenAI transcript cleanup JSON is missing corrections[].");
    }
    return {
      corrections: corrections.map((entry, index) => {
        const item = entry;
        if (typeof item?.id !== "string" || typeof item?.corrected !== "string" || typeof item?.note !== "string") {
          throw new Error(`OpenAI transcript correction at index ${index} is invalid.`);
        }
        return { id: item.id, corrected: item.corrected, note: item.note };
      })
    };
  }
  function normalizeReturnedTranscript(value) {
    return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function isSafeTranscriptRewrite(original, corrected) {
    if (corrected.length < 2 || corrected.length > Math.max(120, original.length * 2.2)) {
      return false;
    }
    if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(corrected)) {
      return false;
    }
    return true;
  }

  // node_modules/fflate/esm/browser.js
  var u8 = Uint8Array;
  var u16 = Uint16Array;
  var i32 = Int32Array;
  var fleb = new u8([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0,
    /* unused */
    0,
    0,
    /* impossible */
    0
  ]);
  var fdeb = new u8([
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
    /* unused */
    0,
    0
  ]);
  var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  var freb = function(eb, start) {
    var b = new u16(31);
    for (var i = 0; i < 31; ++i) {
      b[i] = start += 1 << eb[i - 1];
    }
    var r = new i32(b[30]);
    for (var i = 1; i < 30; ++i) {
      for (var j = b[i]; j < b[i + 1]; ++j) {
        r[j] = j - b[i] << 5 | i;
      }
    }
    return { b, r };
  };
  var _a = freb(fleb, 2);
  var fl = _a.b;
  var revfl = _a.r;
  fl[28] = 258, revfl[258] = 28;
  var _b = freb(fdeb, 0);
  var fd = _b.b;
  var revfd = _b.r;
  var rev = new u16(32768);
  for (i = 0; i < 32768; ++i) {
    x = (i & 43690) >> 1 | (i & 21845) << 1;
    x = (x & 52428) >> 2 | (x & 13107) << 2;
    x = (x & 61680) >> 4 | (x & 3855) << 4;
    rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
  }
  var x;
  var i;
  var hMap = (function(cd, mb, r) {
    var s = cd.length;
    var i = 0;
    var l = new u16(mb);
    for (; i < s; ++i) {
      if (cd[i])
        ++l[cd[i] - 1];
    }
    var le = new u16(mb);
    for (i = 1; i < mb; ++i) {
      le[i] = le[i - 1] + l[i - 1] << 1;
    }
    var co;
    if (r) {
      co = new u16(1 << mb);
      var rvb = 15 - mb;
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          var sv = i << 4 | cd[i];
          var r_1 = mb - cd[i];
          var v = le[cd[i] - 1]++ << r_1;
          for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
            co[rev[v] >> rvb] = sv;
          }
        }
      }
    } else {
      co = new u16(s);
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
        }
      }
    }
    return co;
  });
  var flt = new u8(288);
  for (i = 0; i < 144; ++i)
    flt[i] = 8;
  var i;
  for (i = 144; i < 256; ++i)
    flt[i] = 9;
  var i;
  for (i = 256; i < 280; ++i)
    flt[i] = 7;
  var i;
  for (i = 280; i < 288; ++i)
    flt[i] = 8;
  var i;
  var fdt = new u8(32);
  for (i = 0; i < 32; ++i)
    fdt[i] = 5;
  var i;
  var flm = /* @__PURE__ */ hMap(flt, 9, 0);
  var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
  var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
  var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
  var max = function(a) {
    var m = a[0];
    for (var i = 1; i < a.length; ++i) {
      if (a[i] > m)
        m = a[i];
    }
    return m;
  };
  var bits = function(d, p, m) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
  };
  var bits16 = function(d, p) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
  };
  var shft = function(p) {
    return (p + 7) / 8 | 0;
  };
  var slc = function(v, s, e) {
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    return new u8(v.subarray(s, e));
  };
  var ec = [
    "unexpected EOF",
    "invalid block type",
    "invalid length/literal",
    "invalid distance",
    "stream finished",
    "no stream handler",
    ,
    "no callback",
    "invalid UTF-8 data",
    "extra field too long",
    "date not in range 1980-2099",
    "filename too long",
    "stream finishing",
    "invalid zip data"
    // determined by unknown compression method
  ];
  var err = function(ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
      Error.captureStackTrace(e, err);
    if (!nt)
      throw e;
    return e;
  };
  var inflt = function(dat, st, buf, dict) {
    var sl = dat.length, dl = dict ? dict.length : 0;
    if (!sl || st.f && !st.l)
      return buf || new u8(0);
    var noBuf = !buf;
    var resize = noBuf || st.i != 2;
    var noSt = st.i;
    if (noBuf)
      buf = new u8(sl * 3);
    var cbuf = function(l2) {
      var bl = buf.length;
      if (l2 > bl) {
        var nbuf = new u8(Math.max(bl * 2, l2));
        nbuf.set(buf);
        buf = nbuf;
      }
    };
    var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
    var tbts = sl * 8;
    do {
      if (!lm) {
        final = bits(dat, pos, 1);
        var type = bits(dat, pos + 1, 3);
        pos += 3;
        if (!type) {
          var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
          if (t > sl) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + l);
          buf.set(dat.subarray(s, t), bt);
          st.b = bt += l, st.p = pos = t * 8, st.f = final;
          continue;
        } else if (type == 1)
          lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
        else if (type == 2) {
          var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
          var tl = hLit + bits(dat, pos + 5, 31) + 1;
          pos += 14;
          var ldt = new u8(tl);
          var clt = new u8(19);
          for (var i = 0; i < hcLen; ++i) {
            clt[clim[i]] = bits(dat, pos + i * 3, 7);
          }
          pos += hcLen * 3;
          var clb = max(clt), clbmsk = (1 << clb) - 1;
          var clm = hMap(clt, clb, 1);
          for (var i = 0; i < tl; ) {
            var r = clm[bits(dat, pos, clbmsk)];
            pos += r & 15;
            var s = r >> 4;
            if (s < 16) {
              ldt[i++] = s;
            } else {
              var c = 0, n = 0;
              if (s == 16)
                n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
              else if (s == 17)
                n = 3 + bits(dat, pos, 7), pos += 3;
              else if (s == 18)
                n = 11 + bits(dat, pos, 127), pos += 7;
              while (n--)
                ldt[i++] = c;
            }
          }
          var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
          lbt = max(lt);
          dbt = max(dt);
          lm = hMap(lt, lbt, 1);
          dm = hMap(dt, dbt, 1);
        } else
          err(1);
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
      }
      if (resize)
        cbuf(bt + 131072);
      var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
      var lpos = pos;
      for (; ; lpos = pos) {
        var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
        pos += c & 15;
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (!c)
          err(2);
        if (sym < 256)
          buf[bt++] = sym;
        else if (sym == 256) {
          lpos = pos, lm = null;
          break;
        } else {
          var add = sym - 254;
          if (sym > 264) {
            var i = sym - 257, b = fleb[i];
            add = bits(dat, pos, (1 << b) - 1) + fl[i];
            pos += b;
          }
          var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
          if (!d)
            err(3);
          pos += d & 15;
          var dt = fd[dsym];
          if (dsym > 3) {
            var b = fdeb[dsym];
            dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
          }
          if (pos > tbts) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + 131072);
          var end = bt + add;
          if (bt < dt) {
            var shift = dl - dt, dend = Math.min(dt, end);
            if (shift + bt < 0)
              err(3);
            for (; bt < dend; ++bt)
              buf[bt] = dict[shift + bt];
          }
          for (; bt < end; ++bt)
            buf[bt] = buf[bt - dt];
        }
      }
      st.l = lm, st.p = lpos, st.b = bt, st.f = final;
      if (lm)
        final = 1, st.m = lbt, st.d = dm, st.n = dbt;
    } while (!final);
    return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
  };
  var wbits = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
  };
  var wbits16 = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
    d[o + 2] |= v >> 16;
  };
  var hTree = function(d, mb) {
    var t = [];
    for (var i = 0; i < d.length; ++i) {
      if (d[i])
        t.push({ s: i, f: d[i] });
    }
    var s = t.length;
    var t2 = t.slice();
    if (!s)
      return { t: et, l: 0 };
    if (s == 1) {
      var v = new u8(t[0].s + 1);
      v[t[0].s] = 1;
      return { t: v, l: 1 };
    }
    t.sort(function(a, b) {
      return a.f - b.f;
    });
    t.push({ s: -1, f: 25001 });
    var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
    t[0] = { s: -1, f: l.f + r.f, l, r };
    while (i1 != s - 1) {
      l = t[t[i0].f < t[i2].f ? i0++ : i2++];
      r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
      t[i1++] = { s: -1, f: l.f + r.f, l, r };
    }
    var maxSym = t2[0].s;
    for (var i = 1; i < s; ++i) {
      if (t2[i].s > maxSym)
        maxSym = t2[i].s;
    }
    var tr = new u16(maxSym + 1);
    var mbt = ln(t[i1 - 1], tr, 0);
    if (mbt > mb) {
      var i = 0, dt = 0;
      var lft = mbt - mb, cst = 1 << lft;
      t2.sort(function(a, b) {
        return tr[b.s] - tr[a.s] || a.f - b.f;
      });
      for (; i < s; ++i) {
        var i2_1 = t2[i].s;
        if (tr[i2_1] > mb) {
          dt += cst - (1 << mbt - tr[i2_1]);
          tr[i2_1] = mb;
        } else
          break;
      }
      dt >>= lft;
      while (dt > 0) {
        var i2_2 = t2[i].s;
        if (tr[i2_2] < mb)
          dt -= 1 << mb - tr[i2_2]++ - 1;
        else
          ++i;
      }
      for (; i >= 0 && dt; --i) {
        var i2_3 = t2[i].s;
        if (tr[i2_3] == mb) {
          --tr[i2_3];
          ++dt;
        }
      }
      mbt = mb;
    }
    return { t: new u8(tr), l: mbt };
  };
  var ln = function(n, l, d) {
    return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
  };
  var lc = function(c) {
    var s = c.length;
    while (s && !c[--s])
      ;
    var cl = new u16(++s);
    var cli = 0, cln = c[0], cls = 1;
    var w = function(v) {
      cl[cli++] = v;
    };
    for (var i = 1; i <= s; ++i) {
      if (c[i] == cln && i != s)
        ++cls;
      else {
        if (!cln && cls > 2) {
          for (; cls > 138; cls -= 138)
            w(32754);
          if (cls > 2) {
            w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
            cls = 0;
          }
        } else if (cls > 3) {
          w(cln), --cls;
          for (; cls > 6; cls -= 6)
            w(8304);
          if (cls > 2)
            w(cls - 3 << 5 | 8208), cls = 0;
        }
        while (cls--)
          w(cln);
        cls = 1;
        cln = c[i];
      }
    }
    return { c: cl.subarray(0, cli), n: s };
  };
  var clen = function(cf, cl) {
    var l = 0;
    for (var i = 0; i < cl.length; ++i)
      l += cf[i] * cl[i];
    return l;
  };
  var wfblk = function(out, pos, dat) {
    var s = dat.length;
    var o = shft(pos + 2);
    out[o] = s & 255;
    out[o + 1] = s >> 8;
    out[o + 2] = out[o] ^ 255;
    out[o + 3] = out[o + 1] ^ 255;
    for (var i = 0; i < s; ++i)
      out[o + i + 4] = dat[i];
    return (o + 4 + s) * 8;
  };
  var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
    wbits(out, p++, final);
    ++lf[256];
    var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
    var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
    var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
    var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
    var lcfreq = new u16(19);
    for (var i = 0; i < lclt.length; ++i)
      ++lcfreq[lclt[i] & 31];
    for (var i = 0; i < lcdt.length; ++i)
      ++lcfreq[lcdt[i] & 31];
    var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
    var nlcc = 19;
    for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
      ;
    var flen = bl + 5 << 3;
    var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
    var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
    if (bs >= 0 && flen <= ftlen && flen <= dtlen)
      return wfblk(out, p, dat.subarray(bs, bs + bl));
    var lm, ll, dm, dl;
    wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
    if (dtlen < ftlen) {
      lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
      var llm = hMap(lct, mlcb, 0);
      wbits(out, p, nlc - 257);
      wbits(out, p + 5, ndc - 1);
      wbits(out, p + 10, nlcc - 4);
      p += 14;
      for (var i = 0; i < nlcc; ++i)
        wbits(out, p + 3 * i, lct[clim[i]]);
      p += 3 * nlcc;
      var lcts = [lclt, lcdt];
      for (var it = 0; it < 2; ++it) {
        var clct = lcts[it];
        for (var i = 0; i < clct.length; ++i) {
          var len = clct[i] & 31;
          wbits(out, p, llm[len]), p += lct[len];
          if (len > 15)
            wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
        }
      }
    } else {
      lm = flm, ll = flt, dm = fdm, dl = fdt;
    }
    for (var i = 0; i < li; ++i) {
      var sym = syms[i];
      if (sym > 255) {
        var len = sym >> 18 & 31;
        wbits16(out, p, lm[len + 257]), p += ll[len + 257];
        if (len > 7)
          wbits(out, p, sym >> 23 & 31), p += fleb[len];
        var dst = sym & 31;
        wbits16(out, p, dm[dst]), p += dl[dst];
        if (dst > 3)
          wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
      } else {
        wbits16(out, p, lm[sym]), p += ll[sym];
      }
    }
    wbits16(out, p, lm[256]);
    return p + ll[256];
  };
  var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
  var et = /* @__PURE__ */ new u8(0);
  var dflt = function(dat, lvl, plvl, pre, post, st) {
    var s = st.z || dat.length;
    var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
    var w = o.subarray(pre, o.length - post);
    var lst = st.l;
    var pos = (st.r || 0) & 7;
    if (lvl) {
      if (pos)
        w[0] = st.r >> 3;
      var opt = deo[lvl - 1];
      var n = opt >> 13, c = opt & 8191;
      var msk_1 = (1 << plvl) - 1;
      var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
      var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
      var hsh = function(i2) {
        return (dat[i2] ^ dat[i2 + 1] << bs1_1 ^ dat[i2 + 2] << bs2_1) & msk_1;
      };
      var syms = new i32(25e3);
      var lf = new u16(288), df = new u16(32);
      var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
      for (; i + 2 < s; ++i) {
        var hv = hsh(i);
        var imod = i & 32767, pimod = head[hv];
        prev[imod] = pimod;
        head[hv] = imod;
        if (wi <= i) {
          var rem = s - i;
          if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
            pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
            li = lc_1 = eb = 0, bs = i;
            for (var j = 0; j < 286; ++j)
              lf[j] = 0;
            for (var j = 0; j < 30; ++j)
              df[j] = 0;
          }
          var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
          if (rem > 2 && hv == hsh(i - dif)) {
            var maxn = Math.min(n, rem) - 1;
            var maxd = Math.min(32767, i);
            var ml = Math.min(258, rem);
            while (dif <= maxd && --ch_1 && imod != pimod) {
              if (dat[i + l] == dat[i + l - dif]) {
                var nl = 0;
                for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                  ;
                if (nl > l) {
                  l = nl, d = dif;
                  if (nl > maxn)
                    break;
                  var mmd = Math.min(dif, nl - 2);
                  var md = 0;
                  for (var j = 0; j < mmd; ++j) {
                    var ti = i - dif + j & 32767;
                    var pti = prev[ti];
                    var cd = ti - pti & 32767;
                    if (cd > md)
                      md = cd, pimod = ti;
                  }
                }
              }
              imod = pimod, pimod = prev[imod];
              dif += imod - pimod & 32767;
            }
          }
          if (d) {
            syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
            var lin = revfl[l] & 31, din = revfd[d] & 31;
            eb += fleb[lin] + fdeb[din];
            ++lf[257 + lin];
            ++df[din];
            wi = i + l;
            ++lc_1;
          } else {
            syms[li++] = dat[i];
            ++lf[dat[i]];
          }
        }
      }
      for (i = Math.max(i, wi); i < s; ++i) {
        syms[li++] = dat[i];
        ++lf[dat[i]];
      }
      pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
      if (!lst) {
        st.r = pos & 7 | w[pos / 8 | 0] << 3;
        pos -= 7;
        st.h = head, st.p = prev, st.i = i, st.w = wi;
      }
    } else {
      for (var i = st.w || 0; i < s + lst; i += 65535) {
        var e = i + 65535;
        if (e >= s) {
          w[pos / 8 | 0] = lst;
          e = s;
        }
        pos = wfblk(w, pos + 1, dat.subarray(i, e));
      }
      st.i = s;
    }
    return slc(o, 0, pre + shft(pos) + post);
  };
  var crct = /* @__PURE__ */ (function() {
    var t = new Int32Array(256);
    for (var i = 0; i < 256; ++i) {
      var c = i, k = 9;
      while (--k)
        c = (c & 1 && -306674912) ^ c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  var crc = function() {
    var c = -1;
    return {
      p: function(d) {
        var cr = c;
        for (var i = 0; i < d.length; ++i)
          cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
        c = cr;
      },
      d: function() {
        return ~c;
      }
    };
  };
  var dopt = function(dat, opt, pre, post, st) {
    if (!st) {
      st = { l: 1 };
      if (opt.dictionary) {
        var dict = opt.dictionary.subarray(-32768);
        var newDat = new u8(dict.length + dat.length);
        newDat.set(dict);
        newDat.set(dat, dict.length);
        dat = newDat;
        st.w = dict.length;
      }
    }
    return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
  };
  var wbytes = function(d, b, v) {
    for (; v; ++b)
      d[b] = v, v >>>= 8;
  };
  var gzh = function(c, o) {
    var fn = o.filename;
    c[0] = 31, c[1] = 139, c[2] = 8, c[8] = o.level < 2 ? 4 : o.level == 9 ? 2 : 0, c[9] = 3;
    if (o.mtime != 0)
      wbytes(c, 4, Math.floor(new Date(o.mtime || Date.now()) / 1e3));
    if (fn) {
      c[3] = 8;
      for (var i = 0; i <= fn.length; ++i)
        c[i + 10] = fn.charCodeAt(i);
    }
  };
  var gzs = function(d) {
    if (d[0] != 31 || d[1] != 139 || d[2] != 8)
      err(6, "invalid gzip data");
    var flg = d[3];
    var st = 10;
    if (flg & 4)
      st += (d[10] | d[11] << 8) + 2;
    for (var zs = (flg >> 3 & 1) + (flg >> 4 & 1); zs > 0; zs -= !d[st++])
      ;
    return st + (flg & 2);
  };
  var gzl = function(d) {
    var l = d.length;
    return (d[l - 4] | d[l - 3] << 8 | d[l - 2] << 16 | d[l - 1] << 24) >>> 0;
  };
  var gzhl = function(o) {
    return 10 + (o.filename ? o.filename.length + 1 : 0);
  };
  function gzipSync(data, opts) {
    if (!opts)
      opts = {};
    var c = crc(), l = data.length;
    c.p(data);
    var d = dopt(data, opts, gzhl(opts), 8), s = d.length;
    return gzh(d, opts), wbytes(d, s - 8, c.d()), wbytes(d, s - 4, l), d;
  }
  function gunzipSync(data, opts) {
    var st = gzs(data);
    if (st + 8 > data.length)
      err(6, "invalid gzip data");
    return inflt(data.subarray(st, -8), { i: 2 }, opts && opts.out || new u8(gzl(data)), opts && opts.dictionary);
  }
  var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
  var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
  var tds = 0;
  try {
    td.decode(et, { stream: true });
    tds = 1;
  } catch (e) {
  }
  var dutf8 = function(d) {
    for (var r = "", i = 0; ; ) {
      var c = d[i++];
      var eb = (c > 127) + (c > 223) + (c > 239);
      if (i + eb > d.length)
        return { s: r, r: slc(d, i - 1) };
      if (!eb)
        r += String.fromCharCode(c);
      else if (eb == 3) {
        c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
      } else if (eb & 1)
        r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
      else
        r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
    }
  };
  function strToU8(str, latin1) {
    if (latin1) {
      var ar_1 = new u8(str.length);
      for (var i = 0; i < str.length; ++i)
        ar_1[i] = str.charCodeAt(i);
      return ar_1;
    }
    if (te)
      return te.encode(str);
    var l = str.length;
    var ar = new u8(str.length + (str.length >> 1));
    var ai = 0;
    var w = function(v) {
      ar[ai++] = v;
    };
    for (var i = 0; i < l; ++i) {
      if (ai + 5 > ar.length) {
        var n = new u8(ai + 8 + (l - i << 1));
        n.set(ar);
        ar = n;
      }
      var c = str.charCodeAt(i);
      if (c < 128 || latin1)
        w(c);
      else if (c < 2048)
        w(192 | c >> 6), w(128 | c & 63);
      else if (c > 55295 && c < 57344)
        c = 65536 + (c & 1023 << 10) | str.charCodeAt(++i) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
      else
        w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
    }
    return slc(ar, 0, ai);
  }
  function strFromU8(dat, latin1) {
    if (latin1) {
      var r = "";
      for (var i = 0; i < dat.length; i += 16384)
        r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
      return r;
    } else if (td) {
      return td.decode(dat);
    } else {
      var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
      if (r.length)
        err(8);
      return s;
    }
  }

  // src/platform/utf8.ts
  function decodeUtf8(bytes) {
    return strFromU8(bytes);
  }
  function encodeUtf8(text) {
    return strToU8(text);
  }

  // src/platform/fileSystem.ts
  var UxpFileSystem = class {
    constructor(logger) {
      this.logger = logger;
      this.fs = optionalRequire("fs");
      this.uxp = optionalRequire("uxp");
      this.os = optionalRequire("os");
      this.process = optionalRequire("process");
    }
    async readFileBytes(path) {
      this.logger.debug("Reading file bytes.", { path });
      if (this.fs?.promises?.readFile) {
        return normalizeBytes(await this.fs.promises.readFile(path));
      }
      if (typeof this.fs?.readFile === "function") {
        const raw = await this.fs.readFile(path);
        return normalizeBytes(raw);
      }
      if (typeof this.fs?.readFileSync === "function") {
        return normalizeBytes(this.fs.readFileSync(path));
      }
      const entry = await this.getEntryWithUrl(path);
      if (entry?.read) {
        return normalizeBytes(await entry.read({ format: this.uxp?.storage?.formats?.binary }));
      }
      throw new Error("No UXP file API capable of reading arbitrary project files is available.");
    }
    async readTextFile(path) {
      return decodeUtf8(await this.readFileBytes(path));
    }
    async writeTextFile(path, text) {
      await this.writeFileBytes(path, encodeUtf8(text));
    }
    async writeFileBytes(path, bytes) {
      this.logger.debug("Writing file bytes.", { path, byteLength: bytes.byteLength });
      if (this.fs?.promises?.writeFile) {
        await this.fs.promises.writeFile(path, bytes);
        return;
      }
      if (typeof this.fs?.writeFile === "function") {
        await this.fs.writeFile(path, bytes);
        return;
      }
      if (typeof this.fs?.writeFileSync === "function") {
        this.fs.writeFileSync(path, bytes);
        return;
      }
      const entry = await this.getEntryWithUrl(path);
      if (entry?.write) {
        await entry.write(bytes, { format: this.uxp?.storage?.formats?.binary });
        return;
      }
      throw new Error("No UXP file API capable of writing arbitrary project files is available.");
    }
    async copyFile(source, destination) {
      this.logger.info("Creating project backup.", { source, destination });
      if (this.fs?.promises?.copyFile) {
        await this.fs.promises.copyFile(source, destination);
        return;
      }
      if (typeof this.fs?.copyFile === "function") {
        await this.fs.copyFile(source, destination);
        return;
      }
      if (typeof this.fs?.copyFileSync === "function") {
        this.fs.copyFileSync(source, destination);
        return;
      }
      await this.writeFileBytes(destination, await this.readFileBytes(source));
    }
    async pickJsonTextFile() {
      const pickerHost = this.resolveFilePickerHost();
      if (!pickerHost) {
        throw new Error("This UXP host does not expose a glossary file picker API.");
      }
      const picked = await pickerHost.getFileForOpening({
        types: ["json"],
        allowMultiple: false
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      if (!file) {
        return void 0;
      }
      const nativePath = typeof file.nativePath === "string" ? file.nativePath : this.uxp?.storage?.localFileSystem?.getNativePath?.(file);
      if (typeof file.read === "function") {
        const raw = await this.readPickedFile(file);
        return {
          name: file.name ?? "glossary.json",
          text: raw,
          path: nativePath,
          location: nativePath ?? this.describeEntryLocation(file)
        };
      }
      if (nativePath) {
        return { name: file.name ?? "glossary.json", text: await this.readTextFile(nativePath), path: nativePath, location: nativePath };
      }
      throw new Error("Selected glossary file cannot be read by this UXP host.");
    }
    async loadOrCreateStandardGlossary(defaultText) {
      const local = this.uxp?.storage?.localFileSystem;
      if (!local?.getDataFolder) {
        throw new Error("This UXP host does not expose localFileSystem.getDataFolder().");
      }
      const folder = await local.getDataFolder();
      const fileName = "subtitle-qa-glossary.json";
      let file = await this.findFileInFolder(folder, fileName);
      if (!file) {
        if (typeof folder?.createFile !== "function") {
          throw new Error("This UXP host cannot create a standard glossary file in plugin-data.");
        }
        file = await folder.createFile(fileName, { overwrite: false });
        await this.writeTextToFile(file, defaultText);
        this.logger.info("Created standard glossary file.", { fileName });
      }
      const text = await this.readPickedFile(file);
      return {
        name: file.name ?? fileName,
        text,
        location: this.describeEntryLocation(file)
      };
    }
    async saveStandardGlossary(text) {
      const saved = await this.writeDataFile("subtitle-qa-glossary.json", text);
      return { name: saved.name, location: saved.location };
    }
    async loadOrCreateGlossarySettings(defaultText) {
      return this.loadOrCreateDataFile("subtitle-qa-glossary-settings.json", defaultText);
    }
    async saveGlossarySettings(text) {
      const saved = await this.writeDataFile("subtitle-qa-glossary-settings.json", text);
      return { name: saved.name, location: saved.location };
    }
    async loadOrCreateEngineSettings(defaultText) {
      return this.loadOrCreateDataFile("subtitle-qa-engine-settings.json", defaultText);
    }
    async saveEngineSettings(text) {
      const saved = await this.writeDataFile("subtitle-qa-engine-settings.json", text);
      return { name: saved.name, location: saved.location };
    }
    backupPathFor(projectPath) {
      const { dir, base, ext } = splitPath(projectPath);
      const normalizedBase = base.replace(/\.subtitle-qa-backup(?:-[^.]*)?$/i, "");
      return `${dir}${normalizedBase}.subtitle-qa-backup${ext}`;
    }
    async findSharedGlossaryPath(fileName = "subtitle-qa-glossary.json") {
      for (const candidate of this.sharedGlossaryCandidatePaths(fileName)) {
        if (await this.isReadableFile(candidate)) {
          return candidate;
        }
      }
      const roots = this.sharedGlossarySearchRoots();
      for (const root of roots) {
        const found = await this.findSharedGlossaryUnderRoot(root, fileName, 8);
        if (found) {
          return found;
        }
      }
      return void 0;
    }
    async getEntryWithUrl(path) {
      const localFileSystem = this.uxp?.storage?.localFileSystem;
      if (!localFileSystem?.getEntryWithUrl) {
        return void 0;
      }
      const prefix = path.startsWith("/") ? "file://" : "file:///";
      return localFileSystem.getEntryWithUrl(`${prefix}${path}`);
    }
    async isReadableFile(path) {
      try {
        if (typeof this.fs?.promises?.stat === "function") {
          const stat = await this.fs.promises.stat(path);
          return typeof stat?.isFile === "function" ? stat.isFile() : true;
        }
        await this.readFileBytes(path);
        return true;
      } catch {
        return false;
      }
    }
    sharedGlossaryCandidatePaths(fileName) {
      const home = this.homeDirectory();
      if (!home) {
        return [];
      }
      return [
        joinFsPath(home, "Library", "CloudStorage", "OneDrive-SharedLibraries-contentkuecheGmbH", "contentkueche - Dokumente", "General", "00_COMPANY_BRAIN", fileName),
        joinFsPath(home, "Library", "CloudStorage", "OneDrive-SharedLibraries-contentkuecheGmbH", "contentkueche - Documents", "General", "00_COMPANY_BRAIN", fileName),
        joinFsPath(home, "Library", "CloudStorage", "OneDrive-SharedLibraries-contentkuecheGmbH", "contentkueche - Freigegebene Dokumente", "General", "00_COMPANY_BRAIN", fileName),
        joinFsPath(home, "Library", "CloudStorage", "OneDrive-contentkuecheGmbH", "General", "00_COMPANY_BRAIN", fileName),
        joinFsPath(home, "OneDrive - contentkueche GmbH", "General", "00_COMPANY_BRAIN", fileName),
        joinFsPath(home, "contentkueche GmbH", "General", "00_COMPANY_BRAIN", fileName)
      ];
    }
    sharedGlossarySearchRoots() {
      const home = this.homeDirectory();
      if (!home) {
        return [];
      }
      return [
        joinFsPath(home, "Library", "CloudStorage", "OneDrive-SharedLibraries-contentkuecheGmbH"),
        joinFsPath(home, "Library", "CloudStorage", "OneDrive-contentkuecheGmbH"),
        joinFsPath(home, "OneDrive - contentkueche GmbH"),
        joinFsPath(home, "contentkueche GmbH")
      ];
    }
    async findSharedGlossaryUnderRoot(root, fileName, maxDepth) {
      if (!this.fs?.promises?.readdir || !await this.pathExists(root)) {
        return void 0;
      }
      const stack = [{ path: root, depth: 0 }];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current || current.depth > maxDepth) {
          continue;
        }
        let entries;
        try {
          entries = await this.fs.promises.readdir(current.path, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const name = String(entry?.name ?? "");
          if (!name || name === ".Trash") {
            continue;
          }
          const nextPath = joinFsPath(current.path, name);
          if (isDirectoryEntry(entry)) {
            stack.push({ path: nextPath, depth: current.depth + 1 });
            continue;
          }
          if (name === fileName && normalizedPath(nextPath).includes("/General/00_COMPANY_BRAIN/")) {
            return nextPath;
          }
        }
      }
      return void 0;
    }
    async pathExists(path) {
      try {
        if (typeof this.fs?.promises?.stat === "function") {
          await this.fs.promises.stat(path);
          return true;
        }
        if (typeof this.fs?.existsSync === "function") {
          return Boolean(this.fs.existsSync(path));
        }
        return false;
      } catch {
        return false;
      }
    }
    homeDirectory() {
      if (typeof this.os?.homedir === "function") {
        const home = this.os.homedir();
        if (typeof home === "string" && home.length > 0) {
          return home;
        }
      }
      const env = this.process?.env;
      return env?.HOME ?? env?.USERPROFILE;
    }
    resolveFilePickerHost() {
      if (typeof this.fs?.getFileForOpening === "function") {
        return this.fs;
      }
      const local = this.uxp?.storage?.localFileSystem;
      if (typeof local?.getFileForOpening === "function") {
        return local;
      }
      return void 0;
    }
    async readPickedFile(file) {
      const utf8 = this.uxp?.storage?.formats?.utf8;
      try {
        const content = utf8 ? await file.read({ format: utf8 }) : await file.read();
        if (typeof content === "string") {
          return content;
        }
        return decodeUtf8(normalizeBytes(content));
      } catch {
        const content = await file.read();
        if (typeof content === "string") {
          return content;
        }
        return decodeUtf8(normalizeBytes(content));
      }
    }
    async writeTextToFile(file, text) {
      if (typeof file?.write !== "function") {
        throw new Error("Glossary target file is not writable in this UXP host.");
      }
      const utf8 = this.uxp?.storage?.formats?.utf8;
      if (utf8) {
        await file.write(text, { format: utf8 });
        return;
      }
      await file.write(text);
    }
    async findFileInFolder(folder, fileName) {
      if (typeof folder?.getEntry === "function") {
        try {
          const entry = await folder.getEntry(fileName);
          if (entry?.isFile || typeof entry?.read === "function") {
            return entry;
          }
        } catch {
          return void 0;
        }
        return void 0;
      }
      if (typeof folder?.getEntries === "function") {
        const entries = await folder.getEntries();
        return entries.find((entry) => (entry?.isFile || typeof entry?.read === "function") && entry?.name === fileName);
      }
      return void 0;
    }
    describeEntryLocation(entry) {
      const local = this.uxp?.storage?.localFileSystem;
      if (typeof local?.getFsUrl === "function") {
        try {
          return String(local.getFsUrl(entry));
        } catch {
        }
      }
      if (typeof local?.getNativePath === "function") {
        try {
          return String(local.getNativePath(entry));
        } catch {
        }
      }
      if (entry?.nativePath) {
        return String(entry.nativePath);
      }
      return void 0;
    }
    async loadOrCreateDataFile(fileName, defaultText) {
      const local = this.uxp?.storage?.localFileSystem;
      if (!local?.getDataFolder) {
        throw new Error("This UXP host does not expose localFileSystem.getDataFolder().");
      }
      const folder = await local.getDataFolder();
      let file = await this.findFileInFolder(folder, fileName);
      if (!file) {
        if (typeof folder?.createFile !== "function") {
          throw new Error(`This UXP host cannot create ${fileName} in plugin-data.`);
        }
        file = await folder.createFile(fileName, { overwrite: false });
        await this.writeTextToFile(file, defaultText);
        this.logger.info("Created plugin data file.", { fileName });
      }
      const text = await this.readPickedFile(file);
      return {
        name: file.name ?? fileName,
        text,
        location: this.describeEntryLocation(file)
      };
    }
    async writeDataFile(fileName, text) {
      const local = this.uxp?.storage?.localFileSystem;
      if (!local?.getDataFolder) {
        throw new Error("This UXP host does not expose localFileSystem.getDataFolder().");
      }
      const folder = await local.getDataFolder();
      let file = await this.findFileInFolder(folder, fileName);
      if (!file) {
        if (typeof folder?.createFile !== "function") {
          throw new Error(`This UXP host cannot create ${fileName} in plugin-data.`);
        }
        file = await folder.createFile(fileName, { overwrite: false });
      }
      await this.writeTextToFile(file, text);
      return {
        name: file.name ?? fileName,
        location: this.describeEntryLocation(file)
      };
    }
  };
  function splitPath(path) {
    const separator = path.includes("\\") ? "\\" : "/";
    const slash = path.lastIndexOf(separator);
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const file = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = file.lastIndexOf(".");
    if (dot <= 0) {
      return { dir, base: file, ext: "" };
    }
    return { dir, base: file.slice(0, dot), ext: file.slice(dot) };
  }
  function joinFsPath(...parts) {
    const filtered = parts.filter((part) => part.length > 0);
    if (filtered.length === 0) {
      return "";
    }
    const separator = filtered.some((part) => part.includes("\\")) ? "\\" : "/";
    const joined = filtered.map((part, index) => {
      if (index === 0) {
        return part.replace(/[\\/]+$/g, "");
      }
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    }).join(separator);
    return filtered[0].startsWith("/") ? `/${joined.replace(/^\/+/, "")}` : joined;
  }
  function normalizedPath(path) {
    return path.replace(/\\/g, "/");
  }
  function isDirectoryEntry(entry) {
    if (typeof entry?.isDirectory === "function") {
      return entry.isDirectory();
    }
    return Boolean(entry?.isDirectory);
  }
  function optionalRequire(moduleName) {
    try {
      return __require(moduleName);
    } catch {
      return void 0;
    }
  }
  function normalizeBytes(raw) {
    if (raw instanceof Uint8Array) {
      return raw;
    }
    if (raw instanceof ArrayBuffer) {
      return new Uint8Array(raw);
    }
    if (ArrayBuffer.isView(raw)) {
      const view = raw;
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    if (typeof raw === "string") {
      return encodeUtf8(raw);
    }
    throw new Error("Unsupported file byte payload returned by UXP fs.");
  }

  // src/premiere/premiereContext.ts
  async function getPremiereContext(logger) {
    const ppro = __require("premierepro");
    const capability = {
      activeProject: false,
      activeSequence: false,
      captionTracks: "unknown",
      captionTextRead: "unknown",
      captionTextWrite: "unknown",
      graphicTextRead: "unknown",
      graphicTextWrite: "unknown",
      projectFileFallback: "unknown",
      notes: []
    };
    const project = await ppro.Project.getActiveProject();
    capability.activeProject = Boolean(project);
    if (!project) {
      capability.notes.push("No active Premiere project returned by Project.getActiveProject().");
      return { ppro, capability };
    }
    const sequence = await project.getActiveSequence();
    capability.activeSequence = Boolean(sequence);
    if (!sequence) {
      capability.notes.push("No active sequence returned by project.getActiveSequence().");
    }
    const projectName = readString(project.name) ?? "Untitled Project";
    const projectPath = readString(project.path);
    const sequenceName = readString(sequence?.name);
    logger.info("Resolved Premiere context.", { projectName, projectPath, sequenceName });
    return {
      ppro,
      project,
      sequence,
      projectName,
      projectPath,
      sequenceName,
      capability
    };
  }
  async function saveAndBackupProject(context, copyFile, backupPathFor, logger) {
    if (!context.projectPath) {
      logger.warn("Skipping backup because the active project has no file path.");
      return void 0;
    }
    if (typeof context.project?.save === "function") {
      logger.info("Saving active project before backup.");
      await context.project.save();
    }
    const backupPath = backupPathFor(context.projectPath);
    await copyFile(context.projectPath, backupPath);
    return backupPath;
  }
  function readString(value) {
    return typeof value === "string" && value.length > 0 ? value : void 0;
  }
  function stringifyError(error) {
    if (error instanceof Error) {
      return { name: error.name, message: error.message, stack: error.stack ?? "" };
    }
    return { name: "Error", message: String(error) };
  }

  // src/premiere/nativeScanner.ts
  function looksLikeHumanText(value) {
    const text = value.trim();
    if (text.length < 2 || text.length > 5e3) {
      return false;
    }
    if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(text)) {
      return false;
    }
    if (/^(?:[a-z]+:)?[/\\]/i.test(text) || /^[A-F0-9-]{24,}$/i.test(text)) {
      return false;
    }
    return true;
  }

  // src/premiere/projectFileFallback.ts
  var ProjectFileFallback = class {
    constructor(fs, logger) {
      this.fs = fs;
      this.logger = logger;
    }
    async scan(projectPath, sequenceName) {
      const projectXml = await this.readProjectXml(projectPath);
      const xmlCandidates = extractTextCandidates(projectXml.xml, projectPath, projectXml.compression);
      const base64Scan = extractBase64TextCandidates(projectXml.xml, projectPath, projectXml.compression, {
        includeCaptionBlocks: true,
        includeTranscriptBlocks: false
      });
      const candidates = [...xmlCandidates, ...base64Scan.captionCandidates];
      this.logger.info("Project-file fallback scan complete.", {
        projectPath,
        compression: projectXml.compression,
        xmlCandidates: xmlCandidates.length,
        captionBlockCandidates: base64Scan.captionCandidates.length,
        transcriptOnlyCandidates: base64Scan.transcriptOnlyCandidates,
        stylePayloads: base64Scan.stylePayloads,
        otherBase64Payloads: base64Scan.otherBase64Payloads,
        formattedTextPayloads: base64Scan.formattedTextPayloads,
        candidates: candidates.length
      });
      if (base64Scan.transcriptOnlyCandidates > 0 && base64Scan.captionCandidates.length === 0) {
        this.logger.warn("Project file contains transcript text, but no writable transcript text blocks were found.", {
          transcriptOnlyCandidates: base64Scan.transcriptOnlyCandidates
        });
      }
      return candidates.map((candidate, index) => ({
        id: projectTargetId(candidate),
        source: "project-file",
        label: candidateLabel(candidate, index),
        sequenceName,
        originalText: candidate.decodedOriginal,
        confidence: "low",
        projectFile: candidate
      }));
    }
    async scanTranscript(projectPath, sequenceName) {
      const projectXml = await this.readProjectXml(projectPath);
      const base64Scan = extractBase64TextCandidates(projectXml.xml, projectPath, projectXml.compression, {
        includeCaptionBlocks: false,
        includeTranscriptBlocks: true
      });
      const candidates = base64Scan.transcriptCandidates;
      this.logger.info("Project-file transcript scan complete.", {
        projectPath,
        compression: projectXml.compression,
        transcriptCandidates: candidates.length,
        transcriptOnlyCandidates: base64Scan.transcriptOnlyCandidates,
        stylePayloads: base64Scan.stylePayloads,
        otherBase64Payloads: base64Scan.otherBase64Payloads
      });
      return candidates.map((candidate, index) => ({
        id: projectTargetId(candidate),
        source: "project-file",
        label: transcriptCandidateLabel(candidate, index),
        sequenceName,
        originalText: candidate.decodedOriginal,
        confidence: "low",
        projectFile: candidate
      }));
    }
    async apply(projectPath, acceptedIssues) {
      const projectXml = await this.readProjectXml(projectPath);
      const groups = groupByProjectTarget(acceptedIssues);
      const xmlEdits = [];
      const base64Edits = [];
      for (const { target, issues } of groups) {
        const projectTarget = target.projectFile;
        if (!projectTarget) {
          throw new Error(`Issue target ${target.id} is not a project-file target.`);
        }
        const currentProjectTarget = refreshProjectTarget(projectXml.xml, projectPath, projectXml.compression, projectTarget);
        if (currentProjectTarget.decodedOriginal !== projectTarget.decodedOriginal) {
          throw new Error(`Transcript text changed after scan for ${target.label}. Run Check Transcript again before applying.`);
        }
        if (currentProjectTarget !== projectTarget) {
          this.logger.info("Refreshed project-file target before write.", {
            label: target.label,
            kind: projectTarget.kind
          });
        }
        const correctedText = applyIssueSet(currentProjectTarget.decodedOriginal, issues);
        if (currentProjectTarget.kind === "project-file-offset") {
          xmlEdits.push({
            offset: currentProjectTarget.xmlOffset,
            expected: currentProjectTarget.encodedOriginal,
            replacement: encodeXml(currentProjectTarget.encodedOriginal, correctedText),
            label: target.label
          });
        } else if (currentProjectTarget.kind === "project-file-base64-token") {
          const correctedBytes = strToU8(correctedText);
          if (correctedBytes.byteLength !== currentProjectTarget.byteLength) {
            throw new Error(
              `Binary caption token "${currentProjectTarget.decodedOriginal}" cannot be changed to "${correctedText}" safely because the byte length changes.`
            );
          }
          base64Edits.push({
            base64XmlOffset: currentProjectTarget.base64XmlOffset,
            expectedBase64: currentProjectTarget.base64EncodedOriginal,
            binaryOffset: currentProjectTarget.binaryOffset,
            byteLength: currentProjectTarget.byteLength,
            replacementBytes: correctedBytes,
            label: target.label
          });
        } else {
          if (isTranscriptProjectTarget(currentProjectTarget)) {
            if (!looksLikeTranscriptTextBlock(currentProjectTarget.decodedOriginal)) {
              throw new Error(`Unsafe transcript payload detected for ${target.label}. Scan aborted to avoid project corruption.`);
            }
            if (!looksLikeTranscriptTextBlock(correctedText)) {
              throw new Error(`Refusing to write unsafe transcript correction for ${target.label}.`);
            }
          }
          base64Edits.push({
            base64XmlOffset: currentProjectTarget.base64XmlOffset,
            expectedBase64: currentProjectTarget.base64EncodedOriginal,
            binaryOffset: currentProjectTarget.binaryOffset,
            lengthOffset: currentProjectTarget.lengthOffset,
            byteLength: currentProjectTarget.byteLength,
            replacementBytes: strToU8(correctedText),
            label: target.label
          });
        }
      }
      let xml = projectXml.xml;
      for (const edit of applyBase64Edits(base64Edits)) {
        const actual = xml.slice(edit.offset, edit.offset + edit.expected.length);
        if (actual !== edit.expected) {
          throw new Error(`Project-file base64 target changed before write: ${edit.label}`);
        }
        xml = xml.slice(0, edit.offset) + edit.replacement + xml.slice(edit.offset + edit.expected.length);
      }
      for (const edit of xmlEdits.sort((a, b) => b.offset - a.offset)) {
        const actual = xml.slice(edit.offset, edit.offset + edit.expected.length);
        if (actual !== edit.expected) {
          throw new Error(`Project-file target changed before write: ${edit.label}`);
        }
        xml = xml.slice(0, edit.offset) + edit.replacement + xml.slice(edit.offset + edit.expected.length);
      }
      const bytes = projectXml.compression === "gzip" ? gzipSync(encodeUtf8(xml), { level: 6 }) : encodeUtf8(xml);
      await this.fs.writeFileBytes(projectPath, bytes);
      this.logger.info("Project-file fallback wrote corrected strings.", {
        projectPath,
        xmlEdits: xmlEdits.length,
        base64Edits: base64Edits.length
      });
    }
    async readProjectXml(projectPath) {
      const bytes = await this.fs.readFileBytes(projectPath);
      if (bytes[0] === 31 && bytes[1] === 139) {
        const inflated = gunzipSync(bytes);
        return { xml: decodeUtf8(inflated), compression: "gzip" };
      }
      const xml = decodeUtf8(bytes);
      if (!xml.trimStart().startsWith("<")) {
        throw new Error("Project file is neither gzip-compressed XML nor plain XML.");
      }
      return { xml, compression: "plain" };
    }
  };
  function extractTextCandidates(xml, projectPath, compression) {
    const candidates = [];
    const patterns = [
      /\b(?:ActualText|Text|TextEditValue|String|Content|Contents|Value|Name)="([^"]{2,5000})"/g,
      /<(?:ActualText|Text|TextEditValue|String|Content|Contents|Value)>([^<]{2,5000})<\/(?:ActualText|Text|TextEditValue|String|Content|Contents|Value)>/g
    ];
    for (const pattern of patterns) {
      for (const match of xml.matchAll(pattern)) {
        const encodedOriginal = match[1];
        const decodedOriginal = decodeXml(encodedOriginal).trim();
        const xmlOffset = (match.index ?? 0) + match[0].indexOf(encodedOriginal);
        const nearbyXml = xml.slice(Math.max(0, xmlOffset - 700), Math.min(xml.length, xmlOffset + 700));
        if (!looksLikeHumanText(decodedOriginal) || !nearbyLooksRelevant(nearbyXml, decodedOriginal)) {
          continue;
        }
        candidates.push({
          kind: "project-file-offset",
          projectPath,
          xmlOffset,
          encodedOriginal,
          decodedOriginal,
          compression,
          nearbyXml: compactXml(nearbyXml)
        });
      }
    }
    return dedupeCandidates(candidates);
  }
  function extractBase64TextCandidates(xml, projectPath, compression, options) {
    const captionCandidates = [];
    const transcriptCandidates = [];
    const pattern = /(<([A-Za-z0-9_.:-]+)[^>]+Encoding="base64"[^>]*>)([A-Za-z0-9+/=\s]+)(<\/\2>)/g;
    let formattedTextPayloads = 0;
    let transcriptOnlyCandidates = 0;
    let stylePayloads = 0;
    let otherBase64Payloads = 0;
    for (const match of xml.matchAll(pattern)) {
      const openTag = match[1];
      const tagName = match[2];
      const base64WithWhitespace = match[3];
      const base64EncodedOriginal = base64WithWhitespace.replace(/\s+/g, "");
      const base64XmlOffset = (match.index ?? 0) + openTag.length + base64WithWhitespace.search(/\S/);
      const matchOffset = match.index ?? 0;
      const nearbyXml = xml.slice(Math.max(0, matchOffset - 300), Math.min(xml.length, matchOffset + openTag.length + 300));
      const decoded = decodeBase64(base64EncodedOriginal);
      if (!decoded) {
        continue;
      }
      if (tagName === "TranscriptData") {
        const transcriptBlocks = selectTranscriptTextBlocks(extractLengthPrefixedUtf8TextBlocks(decoded));
        transcriptOnlyCandidates += transcriptBlocks.length;
        if (options.includeTranscriptBlocks) {
          for (const block of transcriptBlocks) {
            transcriptCandidates.push({
              kind: "project-file-base64-string",
              projectPath,
              xmlOffset: base64XmlOffset,
              base64XmlOffset,
              base64EncodedOriginal,
              decodedOriginal: block.text,
              binaryOffset: block.offset,
              lengthOffset: block.lengthOffset,
              byteLength: block.byteLength,
              compression,
              nearbyXml: compactXml(nearbyXml)
            });
          }
        }
        continue;
      }
      if (tagName === "CaptionDataTemplateStyle") {
        stylePayloads += 1;
        continue;
      }
      if (tagName !== "FormattedTextData") {
        otherBase64Payloads += 1;
        continue;
      }
      formattedTextPayloads += 1;
      if (!options.includeCaptionBlocks) {
        continue;
      }
      for (const token of selectCaptionTextBlocks(extractLengthPrefixedUtf8TextBlocks(decoded))) {
        captionCandidates.push({
          kind: "project-file-base64-string",
          projectPath,
          xmlOffset: base64XmlOffset,
          base64XmlOffset,
          base64EncodedOriginal,
          decodedOriginal: token.text,
          binaryOffset: token.offset,
          lengthOffset: token.lengthOffset,
          byteLength: token.byteLength,
          compression,
          nearbyXml: compactXml(nearbyXml)
        });
      }
    }
    return {
      captionCandidates: dedupeCandidates(captionCandidates),
      transcriptCandidates: dedupeCandidates(transcriptCandidates),
      formattedTextPayloads,
      transcriptOnlyCandidates,
      stylePayloads,
      otherBase64Payloads
    };
  }
  function refreshProjectTarget(xml, projectPath, compression, target) {
    if (target.kind === "project-file-offset") {
      const actual = xml.slice(target.xmlOffset, target.xmlOffset + target.encodedOriginal.length);
      if (actual === target.encodedOriginal) {
        return target;
      }
      const nextOffset = xml.indexOf(target.encodedOriginal);
      if (nextOffset >= 0) {
        return { ...target, xmlOffset: nextOffset };
      }
      return target;
    }
    const scan = extractBase64TextCandidates(xml, projectPath, compression, {
      includeCaptionBlocks: true,
      includeTranscriptBlocks: true
    });
    const candidates = [...scan.captionCandidates, ...scan.transcriptCandidates].filter(
      (candidate) => candidate.kind === target.kind && candidate.decodedOriginal === target.decodedOriginal
    );
    if (candidates.length === 0) {
      return target;
    }
    const sameOffset = candidates.find(
      (candidate) => candidate.kind !== "project-file-offset" && candidate.binaryOffset === target.binaryOffset
    );
    if (sameOffset) {
      return sameOffset;
    }
    return candidates.sort((a, b) => candidateDistance(a, target) - candidateDistance(b, target))[0] ?? target;
  }
  function candidateDistance(candidate, target) {
    if (candidate.kind === "project-file-offset" || target.kind === "project-file-offset") {
      return Number.MAX_SAFE_INTEGER;
    }
    return Math.abs(candidate.base64XmlOffset - target.base64XmlOffset) + Math.abs(candidate.binaryOffset - target.binaryOffset);
  }
  function extractLengthPrefixedUtf8TextBlocks(bytes) {
    const blocks = [];
    for (let lengthOffset = 0; lengthOffset < bytes.byteLength - 6; lengthOffset += 1) {
      const byteLength = readUint32LE(bytes, lengthOffset);
      const stringOffset = lengthOffset + 4;
      if (byteLength < 2 || byteLength > 25e4 || stringOffset + byteLength > bytes.byteLength) {
        continue;
      }
      const text = tryDecodeUtf8(bytes.subarray(stringOffset, stringOffset + byteLength))?.replace(/\0+$/g, "");
      if (!text?.trim() || !looksLikeHumanText(text) || !looksLikeCaptionTextBlock(text)) {
        continue;
      }
      blocks.push({ lengthOffset, offset: stringOffset, byteLength, text });
    }
    return dedupeTextBlocks(blocks);
  }
  function applyBase64Edits(edits) {
    const groups = /* @__PURE__ */ new Map();
    for (const edit of edits) {
      const key = `${edit.base64XmlOffset}:${edit.expectedBase64}`;
      const current = groups.get(key) ?? [];
      current.push(edit);
      groups.set(key, current);
    }
    return [...groups.values()].map((group) => {
      const first = group[0];
      let bytes = decodeBase64(first.expectedBase64);
      if (!bytes) {
        throw new Error(`Could not decode base64 caption payload for ${first.label}.`);
      }
      for (const edit of group.sort((a, b) => b.binaryOffset - a.binaryOffset)) {
        const current = bytes.subarray(edit.binaryOffset, edit.binaryOffset + edit.byteLength);
        if (edit.lengthOffset === void 0 && current.byteLength !== edit.replacementBytes.byteLength) {
          throw new Error(`Binary caption token changed before write: ${edit.label}`);
        }
        if (edit.lengthOffset === void 0) {
          bytes.set(edit.replacementBytes, edit.binaryOffset);
          continue;
        }
        bytes = replaceLengthPrefixedUtf8Block(bytes, edit.lengthOffset, edit.binaryOffset, edit.byteLength, edit.replacementBytes);
      }
      return {
        offset: first.base64XmlOffset,
        expected: first.expectedBase64,
        replacement: encodeBase64(bytes),
        label: first.label
      };
    }).sort((a, b) => b.offset - a.offset);
  }
  function nearbyLooksRelevant(nearbyXml, text) {
    const nearby = nearbyXml.toLowerCase();
    if (nearby.includes("caption") || nearby.includes("subtitle") || nearby.includes("graphic") || nearby.includes("mogrt")) {
      return true;
    }
    return text.split(/\s+/).length >= 3 && /[.!?]?$/.test(text);
  }
  function dedupeCandidates(candidates) {
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const candidate of candidates) {
      const key = candidate.kind === "project-file-offset" ? `${candidate.xmlOffset}:${candidate.encodedOriginal}` : `${candidate.base64XmlOffset}:${candidate.binaryOffset}:${candidate.decodedOriginal}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(candidate);
      }
    }
    return result;
  }
  function candidateLabel(candidate, index) {
    if (candidate.kind === "project-file-base64-token") {
      return `Encoded caption token ${index + 1} \xB7 binary offset ${candidate.binaryOffset}`;
    }
    if (candidate.kind === "project-file-base64-string") {
      return `Caption block ${index + 1} \xB7 binary offset ${candidate.binaryOffset}`;
    }
    const objectName = /(?:Name|ObjectName)="([^"]+)"/.exec(candidate.nearbyXml)?.[1];
    const prefix = objectName ? decodeXml(objectName) : `Project string ${index + 1}`;
    return `${prefix} \xB7 XML offset ${candidate.xmlOffset}`;
  }
  function transcriptCandidateLabel(candidate, index) {
    if (candidate.kind === "project-file-base64-token" || candidate.kind === "project-file-base64-string") {
      return `Transcript block ${index + 1} \xB7 binary offset ${candidate.binaryOffset}`;
    }
    return `Transcript string ${index + 1} \xB7 XML offset ${candidate.xmlOffset}`;
  }
  function isTranscriptProjectTarget(target) {
    if (target.kind === "project-file-offset") {
      return /transcriptdata/i.test(target.nearbyXml);
    }
    return /transcriptdata/i.test(target.nearbyXml);
  }
  function projectTargetId(candidate) {
    if (candidate.kind === "project-file-base64-token" || candidate.kind === "project-file-base64-string") {
      return `project-file:${candidate.base64XmlOffset}:${candidate.binaryOffset}:${hashString(candidate.decodedOriginal)}`;
    }
    return `project-file:${candidate.xmlOffset}:${hashString(candidate.decodedOriginal)}`;
  }
  function groupByProjectTarget(issues) {
    const map = /* @__PURE__ */ new Map();
    for (const issue of issues) {
      const current = map.get(issue.targetId) ?? { target: issue.target, issues: [] };
      current.issues.push(issue);
      map.set(issue.targetId, current);
    }
    return [...map.values()];
  }
  function decodeXml(value) {
    return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  function encodeXml(originalEncoded, value) {
    const quoteEncoded = originalEncoded.includes("&quot;");
    const apostropheEncoded = originalEncoded.includes("&apos;");
    let encoded = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (quoteEncoded || originalEncoded.includes('"')) {
      encoded = encoded.replace(/"/g, "&quot;");
    }
    if (apostropheEncoded) {
      encoded = encoded.replace(/'/g, "&apos;");
    }
    return encoded;
  }
  function compactXml(value) {
    return value.replace(/\s+/g, " ").slice(0, 1200);
  }
  function looksLikeCaptionTextBlock(value) {
    const text = value.trim();
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
      return false;
    }
    return text.includes(" ") || text.includes("\r") || text.includes("\n") || text.split(/\s+/).length > 1;
  }
  function dedupeTextBlocks(blocks) {
    const ordered = [...blocks].sort((a, b) => b.byteLength - a.byteLength);
    const selected = [];
    for (const block of ordered) {
      const overlaps = selected.some(
        (item) => block.offset >= item.offset && block.offset + block.byteLength <= item.offset + item.byteLength
      );
      if (!overlaps) {
        selected.push(block);
      }
    }
    return selected.sort((a, b) => a.offset - b.offset);
  }
  function selectCaptionTextBlocks(blocks) {
    if (blocks.length <= 1) {
      return blocks;
    }
    const best = [...blocks].sort((a, b) => captionBlockScore(b) - captionBlockScore(a))[0];
    return best ? [best] : [];
  }
  function selectTranscriptTextBlocks(blocks) {
    if (blocks.length === 0) {
      return [];
    }
    const vetted = blocks.filter((block) => looksLikeTranscriptTextBlock(block.text));
    if (vetted.length === 0) {
      return [];
    }
    const ordered = [...vetted].sort((a, b) => transcriptBlockScore(b) - transcriptBlockScore(a));
    const best = ordered[0];
    return best ? [best] : [];
  }
  function captionBlockScore(block) {
    const text = block.text.trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const hasLineBreak = /[\r\n]/.test(text) ? 50 : 0;
    return block.offset + wordCount * 25 + hasLineBreak;
  }
  function transcriptBlockScore(block) {
    const words = block.text.trim().split(/\s+/).filter(Boolean).length;
    const lineBreaks = (block.text.match(/[\r\n]+/g) ?? []).length;
    const quality = transcriptTextQualityScore(block.text);
    return block.byteLength + words * 8 + lineBreaks * 16 + quality * 24;
  }
  function looksLikeTranscriptTextBlock(value) {
    const text = value.replace(/\0+$/g, "").trim();
    if (text.length < 20 || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
      return false;
    }
    if (text.includes("\uFFFD")) {
      return false;
    }
    if (/[\\\[\]{}<>]/.test(text)) {
      return false;
    }
    const words = text.match(/\b[\p{L}\p{M}]{2,}\b/gu) ?? [];
    if (words.length < 4) {
      return false;
    }
    const disallowedChars = text.match(/[^\p{L}\p{M}\p{N}\s.,;:!?'"“”‘’()\-–—/…%&+]/gu) ?? [];
    if (disallowedChars.length > 0) {
      return false;
    }
    return transcriptTextQualityScore(text) >= 2;
  }
  function transcriptTextQualityScore(value) {
    const text = value.replace(/\0+$/g, "").trim();
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    const spaces = text.match(/\s/gu)?.length ?? 0;
    const words = text.match(/\b[\p{L}\p{M}]{2,}\b/gu)?.length ?? 0;
    const punctuation = text.match(/[.,;:!?]/g)?.length ?? 0;
    const total = text.length;
    if (total === 0) {
      return 0;
    }
    let score = 0;
    if (letters / total >= 0.55) {
      score += 1;
    }
    if (spaces / total >= 0.08) {
      score += 1;
    }
    if (words >= 8) {
      score += 2;
    } else if (words >= 4) {
      score += 1;
    }
    if (punctuation >= 1) {
      score += 1;
    }
    if (/[\r\n]/.test(text)) {
      score += 1;
    }
    return score;
  }
  function replaceLengthPrefixedUtf8Block(bytes, lengthOffset, stringOffset, byteLength, replacementBytes) {
    const currentLength = readUint32LE(bytes, lengthOffset);
    if (currentLength !== byteLength) {
      throw new Error("Caption text length field changed before write.");
    }
    const next = spliceBytes(bytes, stringOffset, byteLength, replacementBytes);
    writeUint32LE(next, lengthOffset, replacementBytes.byteLength);
    const priorTopLength = readUint32LE(bytes, 0);
    const expectedPriorTopLength = Math.max(0, bytes.byteLength - 12);
    const hasTopLevelLengthField = lengthOffset !== 0 && priorTopLength === expectedPriorTopLength;
    if (hasTopLevelLengthField) {
      writeUint32LE(next, 0, Math.max(0, next.byteLength - 12));
    }
    return next;
  }
  function spliceBytes(bytes, offset, deleteLength, replacement) {
    const next = new Uint8Array(bytes.byteLength - deleteLength + replacement.byteLength);
    next.set(bytes.subarray(0, offset), 0);
    next.set(replacement, offset);
    next.set(bytes.subarray(offset + deleteLength), offset + replacement.byteLength);
    return next;
  }
  function tryDecodeUtf8(bytes) {
    try {
      return strFromU8(bytes);
    } catch {
      return void 0;
    }
  }
  function readUint32LE(bytes, offset) {
    return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
  }
  function writeUint32LE(bytes, offset, value) {
    bytes[offset] = value & 255;
    bytes[offset + 1] = value >> 8 & 255;
    bytes[offset + 2] = value >> 16 & 255;
    bytes[offset + 3] = value >> 24 & 255;
  }
  function decodeBase64(value) {
    try {
      const clean = value.replace(/\s+/g, "");
      const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
      const output = new Uint8Array(clean.length * 3 / 4 - padding);
      let buffer = 0;
      let bits2 = 0;
      let out = 0;
      for (const char of clean) {
        if (char === "=") {
          break;
        }
        const value2 = base64Alphabet.indexOf(char);
        if (value2 < 0) {
          return void 0;
        }
        buffer = buffer << 6 | value2;
        bits2 += 6;
        if (bits2 >= 8) {
          bits2 -= 8;
          output[out] = buffer >> bits2 & 255;
          out += 1;
        }
      }
      return output;
    } catch {
      return void 0;
    }
  }
  function encodeBase64(bytes) {
    let result = "";
    for (let index = 0; index < bytes.byteLength; index += 3) {
      const first = bytes[index];
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      const chunk = first << 16 | (second ?? 0) << 8 | (third ?? 0);
      result += base64Alphabet[chunk >> 18 & 63];
      result += base64Alphabet[chunk >> 12 & 63];
      result += index + 1 < bytes.byteLength ? base64Alphabet[chunk >> 6 & 63] : "=";
      result += index + 2 < bytes.byteLength ? base64Alphabet[chunk & 63] : "=";
    }
    return result;
  }
  var base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function hashString(value) {
    let hash = 5381;
    for (let index = 0; index < value.length; index += 1) {
      hash = hash * 33 ^ value.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
  }

  // src/premiere/applyFixes.ts
  var FixApplier = class {
    constructor(fs, fallback, transcriptApi, logger) {
      this.fs = fs;
      this.fallback = fallback;
      this.transcriptApi = transcriptApi;
      this.logger = logger;
      this.backupByScanKey = /* @__PURE__ */ new Map();
    }
    async apply(context, issues, options = {}) {
      const accepted = issues.filter((issue) => issue.status === "accepted");
      if (accepted.length === 0) {
        return { appliedCount: 0, mode: "none", message: "No accepted issues to apply." };
      }
      const scanBackupKey = buildScanBackupKey(context.projectPath, options.backupReuseKey);
      let backupPath;
      if (scanBackupKey && this.backupByScanKey.has(scanBackupKey)) {
        backupPath = this.backupByScanKey.get(scanBackupKey);
        this.logger.info("Reusing existing backup for this scan.", { backupPath });
      } else {
        backupPath = await saveAndBackupProject(
          context,
          (source, destination) => this.fs.copyFile(source, destination),
          (projectPath) => this.fs.backupPathFor(projectPath),
          this.logger
        );
        if (scanBackupKey) {
          this.backupByScanKey.set(scanBackupKey, backupPath);
        }
      }
      const nativeIssues = accepted.filter((issue) => issue.target.source === "graphic-text" || issue.target.source === "native-caption");
      const transcriptApiIssues = accepted.filter((issue) => issue.target.source === "transcript-api");
      const projectFileIssues = accepted.filter((issue) => issue.target.source === "project-file");
      let appliedCount = 0;
      if (nativeIssues.length > 0) {
        appliedCount += await this.applyNative(context, nativeIssues);
      }
      if (transcriptApiIssues.length > 0) {
        appliedCount += await this.transcriptApi.apply(context, transcriptApiIssues);
      }
      if (projectFileIssues.length > 0) {
        if (!context.projectPath) {
          throw new Error("Cannot apply project-file fallback because the active project has no path.");
        }
        await this.fallback.apply(context.projectPath, projectFileIssues);
        appliedCount += projectFileIssues.length;
        await this.tryReloadProject(context);
      }
      return {
        appliedCount,
        backupPath,
        mode: projectFileIssues.length > 0 ? "project-file-fallback" : "official-api",
        message: `Applied ${appliedCount} accepted fix${appliedCount === 1 ? "" : "es"}.`
      };
    }
    async applyNative(context, issues) {
      const groups = groupByTarget(issues);
      const actions = [];
      for (const { target, issues: targetIssues } of groups) {
        const correctedText = applyIssueSet(target.originalText, targetIssues);
        const action = await createNativeSetTextAction(target, correctedText);
        if (action) {
          actions.push(action);
          continue;
        }
        const appliedDirectly = await applyDirectCaptionMutation(target, correctedText);
        if (!appliedDirectly) {
          throw new Error(`No writable official Premiere text API for ${target.label}.`);
        }
      }
      if (actions.length > 0) {
        if (typeof context.project?.executeTransaction !== "function") {
          throw new Error("Premiere project does not expose executeTransaction().");
        }
        await context.project.executeTransaction((compoundAction) => {
          for (const action of actions) {
            compoundAction.addAction(action);
          }
        }, "Subtitle QA: Apply accepted transcript fixes");
      }
      return issues.length;
    }
    async tryReloadProject(context) {
      if (!context.projectPath || typeof context.ppro?.Project?.open !== "function") {
        this.logger.warn("Project-file fallback wrote the project file, but this host cannot reload it automatically.");
        return;
      }
      try {
        await this.closeCurrentProjectWithoutSaving(context);
        await openProjectWithFallback(context, this.logger);
        this.logger.info("Reopened the patched project file in Premiere.", { projectPath: context.projectPath });
      } catch (error) {
        this.logger.warn("Patched project file was written, but automatic reload failed.", stringifyError(error));
      }
    }
    async closeCurrentProjectWithoutSaving(context) {
      if (typeof context.project?.close !== "function") {
        return;
      }
      this.logger.info("Closing current project before reopening patched project file.");
      const closeOptions = createCloseProjectOptions(context.ppro);
      if (closeOptions) {
        try {
          await context.project.close(closeOptions);
          return;
        } catch (error) {
          this.logger.warn("Project close with options failed; retrying without options.", stringifyError(error));
        }
      }
      await context.project.close();
    }
  };
  function buildScanBackupKey(projectPath, reuseKey) {
    if (!projectPath || !reuseKey) {
      return void 0;
    }
    return `${projectPath}::${reuseKey}`;
  }
  async function openProjectWithFallback(context, logger) {
    const openOptions = createOpenProjectOptions(context.ppro);
    if (openOptions) {
      try {
        await context.ppro.Project.open(context.projectPath, openOptions);
        return;
      } catch (error) {
        logger.warn("Project open with options failed; retrying without options.", stringifyError(error));
      }
    }
    await context.ppro.Project.open(context.projectPath);
  }
  function createOpenProjectOptions(ppro) {
    const options = instantiateOption(ppro?.OpenProjectOptions);
    if (!options) {
      return void 0;
    }
    options.setShowConvertProjectDialog?.(false);
    options.setShowLocateFileDialog?.(false);
    options.setShowWarningDialog?.(false);
    options.setAddToMRUList?.(false);
    return options;
  }
  function createCloseProjectOptions(ppro) {
    const options = instantiateOption(ppro?.CloseProjectOptions);
    if (!options) {
      return void 0;
    }
    options.setPromptIfDirty?.(false);
    options.setShowCancelButton?.(false);
    options.setSaveWorkspace?.(false);
    options.setIsAppBeingPreparedToQuit?.(false);
    return options;
  }
  function instantiateOption(OptionCtor) {
    if (typeof OptionCtor !== "function") {
      return void 0;
    }
    try {
      return new OptionCtor();
    } catch {
      try {
        return OptionCtor();
      } catch {
        return void 0;
      }
    }
  }
  function groupByTarget(issues) {
    const map = /* @__PURE__ */ new Map();
    for (const issue of issues) {
      const current = map.get(issue.targetId) ?? { target: issue.target, issues: [] };
      current.issues.push(issue);
      map.set(issue.targetId, current);
    }
    return [...map.values()];
  }
  async function createNativeSetTextAction(target, correctedText) {
    const native = target.native;
    if (!native) {
      return void 0;
    }
    if (native.kind === "component-param" && native.param?.createKeyframe && native.param?.createSetValueAction) {
      const keyframe = await native.param.createKeyframe(correctedText);
      return native.param.createSetValueAction(keyframe, false);
    }
    if (native.kind === "caption-method" && native.trackItem) {
      if (native.trackItem.createSetTextAction) {
        return native.trackItem.createSetTextAction(correctedText);
      }
      if (native.trackItem.createSetCaptionTextAction) {
        return native.trackItem.createSetCaptionTextAction(correctedText);
      }
    }
    return void 0;
  }
  async function applyDirectCaptionMutation(target, correctedText) {
    const item = target.native?.trackItem;
    if (!item) {
      return false;
    }
    if (typeof item.setText === "function") {
      await item.setText(correctedText);
      return true;
    }
    if (typeof item.setCaptionText === "function") {
      await item.setCaptionText(correctedText);
      return true;
    }
    if ("text" in item) {
      item.text = correctedText;
      return true;
    }
    return false;
  }

  // src/premiere/transcriptApi.ts
  var TranscriptApiBridge = class {
    constructor(logger) {
      this.logger = logger;
    }
    async scan(context) {
      const payload = await this.exportTranscriptJson(context);
      if (!payload) {
        return [];
      }
      const transcript = parseTranscriptJson(payload);
      const segments = transcript.segments ?? [];
      const targets = [];
      for (let index = 0; index < segments.length; index += 1) {
        const words = Array.isArray(segments[index]?.words) ? segments[index]?.words ?? [] : [];
        const text = composeTranscriptText(words);
        if (!looksLikeHumanText(text)) {
          continue;
        }
        targets.push({
          id: `transcript-api:${index}:${hashString2(text)}`,
          source: "transcript-api",
          label: `Transcript segment ${index + 1}`,
          sequenceName: context.sequenceName,
          originalText: text,
          confidence: "high",
          native: {
            kind: "transcript-segment",
            transcriptSegmentIndex: index,
            accessor: "Transcript.exportToJSON"
          }
        });
      }
      this.logger.info("Official transcript API scan complete.", {
        segments: segments.length,
        textTargets: targets.length
      });
      return targets;
    }
    async apply(context, issues) {
      if (issues.length === 0) {
        return 0;
      }
      const payload = await this.exportTranscriptJson(context);
      if (!payload) {
        throw new Error("Official Transcript API is unavailable in this Premiere host.");
      }
      const transcript = parseTranscriptJson(payload);
      const originalTranscript = cloneTranscript(transcript);
      const segments = transcript.segments ?? [];
      const groups = groupBySegment(issues);
      const updatePlans = [];
      for (const [segmentIndex, segmentIssues] of groups) {
        const segment = segments[segmentIndex];
        if (!segment || !Array.isArray(segment.words)) {
          this.logger.warn("Transcript segment missing at apply time; skipping.", { segmentIndex });
          continue;
        }
        const originalText = composeTranscriptText(segment.words);
        const scanText = segmentIssues[0]?.originalText ?? "";
        if (scanText && !sameTranscriptText(originalText, scanText)) {
          this.logger.warn("Transcript segment changed after scan; skipping to avoid overwriting newer edits.", {
            segmentIndex,
            scanPreview: scanText.slice(0, 140),
            currentPreview: originalText.slice(0, 140)
          });
          continue;
        }
        const fullRewriteIssue = segmentIssues.find((issue) => issue.ruleId === FULL_TRANSCRIPT_REWRITE_RULE_ID);
        const correctedText = fullRewriteIssue ? fullRewriteIssue.replacement.replacement : applyIssueSet(originalText, segmentIssues);
        if (correctedText === originalText) {
          continue;
        }
        if (!looksLikeHumanText(correctedText)) {
          this.logger.warn("Refusing unsafe transcript correction.", { segmentIndex });
          continue;
        }
        const updatedWords = fullRewriteIssue ? rewriteWordsWithTiming(segment.words, correctedText) : applyCorrectionToWords(segment.words, correctedText);
        if (!updatedWords) {
          this.logger.warn(
            fullRewriteIssue ? "Skipping transcript segment because a timed full rewrite could not be generated." : "Skipping transcript segment because correction is not token-stable for the official Transcript API.",
            {
              segmentIndex,
              originalPreview: originalText.slice(0, 140),
              correctedPreview: correctedText.slice(0, 140)
            }
          );
          continue;
        }
        const roundTripText = composeTranscriptText(updatedWords);
        if (!sameTranscriptText(roundTripText, correctedText)) {
          this.logger.warn("Skipping transcript segment because token roundtrip did not match the intended correction.", {
            segmentIndex,
            correctedPreview: correctedText.slice(0, 140),
            roundTripPreview: roundTripText.slice(0, 140)
          });
          continue;
        }
        if (!hasUsableTiming(updatedWords)) {
          this.logger.warn("Skipping transcript segment because generated words do not contain usable timing.", { segmentIndex });
          continue;
        }
        updatePlans.push({
          correctedText,
          issueCount: segmentIssues.length,
          segmentIndex,
          updatedWords
        });
      }
      if (updatePlans.length === 0) {
        this.logger.warn("No transcript segments could be updated safely.");
        return 0;
      }
      const ppro = context.ppro;
      const clipProjectItems = await getTranscriptImportCandidates(context);
      if (clipProjectItems.length === 0) {
        throw new Error("Could not resolve clip project item for transcript import.");
      }
      if (typeof ppro?.Transcript?.importFromJSON !== "function") {
        throw new Error("This Premiere host does not expose Transcript.importFromJSON().");
      }
      if (typeof ppro?.Transcript?.createImportTextSegmentsAction !== "function") {
        throw new Error("This Premiere host does not expose Transcript.createImportTextSegmentsAction().");
      }
      if (typeof context.project?.executeTransaction !== "function") {
        throw new Error("Premiere project does not expose executeTransaction() for transcript import.");
      }
      applyPlansToTranscript(transcript, updatePlans);
      const totalIssueCount = updatePlans.reduce((sum, plan) => sum + plan.issueCount, 0);
      const fullAttempt = tryImportTranscript(context, transcript, clipProjectItems, this.logger);
      if (fullAttempt.success) {
        const mismatches2 = await this.verifyImportedTranscript(context, updatePlans);
        if (mismatches2.length > 0) {
          this.logger.error("Transcript import verification failed; restoring previous transcript JSON.", { mismatches: mismatches2 });
          tryImportTranscript(context, originalTranscript, clipProjectItems, this.logger);
          throw new Error(`Transcript import verification failed for segment(s): ${mismatches2.join(", ")}. Previous transcript was restored.`);
        }
        this.logger.info("Official transcript API wrote corrected transcript segments.", {
          changedSegments: updatePlans.length,
          appliedIssues: totalIssueCount
        });
        return totalIssueCount;
      }
      this.logger.warn("Bulk transcript import failed; retrying one segment at a time.", {
        changedSegments: updatePlans.length,
        message: fullAttempt.errorMessage
      });
      let currentTranscript = cloneTranscript(originalTranscript);
      let appliedIssueCount = 0;
      let appliedSegmentCount = 0;
      const appliedPlans = [];
      const failedSegments = [];
      for (const plan of updatePlans) {
        const candidateTranscript = cloneTranscript(currentTranscript);
        if (!applyPlansToTranscript(candidateTranscript, [plan])) {
          failedSegments.push(plan.segmentIndex);
          continue;
        }
        const attempt = tryImportTranscript(context, candidateTranscript, clipProjectItems, this.logger, plan.segmentIndex);
        if (!attempt.success) {
          failedSegments.push(plan.segmentIndex);
          this.logger.warn("Transcript segment apply failed; skipping segment.", {
            segmentIndex: plan.segmentIndex,
            message: attempt.errorMessage
          });
          continue;
        }
        currentTranscript = candidateTranscript;
        appliedSegmentCount += 1;
        appliedIssueCount += plan.issueCount;
        appliedPlans.push(plan);
      }
      if (appliedSegmentCount === 0) {
        throw new Error(fullAttempt.errorMessage);
      }
      const mismatches = await this.verifyImportedTranscript(context, appliedPlans);
      if (mismatches.length > 0) {
        this.logger.error("Transcript import verification failed after segment fallback; restoring previous transcript JSON.", { mismatches });
        tryImportTranscript(context, originalTranscript, clipProjectItems, this.logger);
        throw new Error(`Transcript import verification failed for segment(s): ${mismatches.join(", ")}. Previous transcript was restored.`);
      }
      if (failedSegments.length > 0) {
        this.logger.warn("Transcript apply completed with skipped segments.", {
          appliedSegments: appliedSegmentCount,
          failedSegments,
          totalSegments: updatePlans.length
        });
      }
      this.logger.info("Official transcript API wrote corrected transcript segments.", {
        changedSegments: appliedSegmentCount,
        appliedIssues: appliedIssueCount
      });
      return appliedIssueCount;
    }
    detectCaptionGenerationApis(context) {
      const candidates = [
        ...methodNames(context.ppro?.Transcript).map((name) => `ppro.Transcript.${name}`),
        ...methodNames(context.ppro?.CaptionTrack).map((name) => `ppro.CaptionTrack.${name}`),
        ...methodNames(context.ppro?.Caption).map((name) => `ppro.Caption.${name}`),
        ...methodNames(context.sequence).map((name) => `sequence.${name}`)
      ];
      return candidates.filter((name) => /(caption|subtitle)/i.test(name) && /(create|generate|import|add|insert)/i.test(name)).sort();
    }
    async verifyImportedTranscript(context, plans) {
      const payload = await this.exportTranscriptJson(context);
      if (!payload) {
        return plans.map((plan) => plan.segmentIndex);
      }
      const imported = parseTranscriptJson(payload);
      const segments = imported.segments ?? [];
      const mismatches = [];
      for (const plan of plans) {
        const words = segments[plan.segmentIndex]?.words;
        const text = Array.isArray(words) ? composeTranscriptText(words) : "";
        if (!sameTranscriptText(text, plan.correctedText)) {
          mismatches.push(plan.segmentIndex);
        }
      }
      return mismatches;
    }
    async exportTranscriptJson(context) {
      const ppro = context.ppro;
      if (typeof ppro?.Transcript?.exportToJSON !== "function") {
        return void 0;
      }
      const clipProjectItems = await getTranscriptImportCandidates(context);
      const clipProjectItem = clipProjectItems[0];
      if (!clipProjectItem) {
        return void 0;
      }
      const exported = await ppro.Transcript.exportToJSON(clipProjectItem);
      if (typeof exported !== "string" || !exported.trim()) {
        return void 0;
      }
      return exported;
    }
  };
  async function getTranscriptImportCandidates(context) {
    const items = [];
    items.push(...await getSequenceProjectItemCandidates(context));
    items.push(...await getSelectedProjectItemCandidates(context));
    items.push(...await getRootClipProjectItemCandidates(context));
    return dedupeObjects(items);
  }
  async function getSequenceProjectItemCandidates(context) {
    const sequence = context.sequence;
    if (!sequence || typeof sequence.getProjectItem !== "function") {
      return [];
    }
    const projectItem = await sequence.getProjectItem();
    if (!projectItem) {
      return [];
    }
    const items = [projectItem];
    const cast = context.ppro?.ClipProjectItem?.cast;
    if (typeof cast === "function") {
      try {
        const castItem = cast(projectItem);
        if (castItem) {
          items.unshift(castItem);
        }
      } catch {
      }
    }
    return items;
  }
  async function getSelectedProjectItemCandidates(context) {
    const projectUtils = context.ppro?.ProjectUtils;
    if (!projectUtils || typeof projectUtils.getSelection !== "function") {
      return [];
    }
    const selection = await projectUtils.getSelection(context.project);
    if (!selection) {
      return [];
    }
    const selectedItems = await normalizeSelectionItems(selection);
    const candidates = [];
    for (const item of selectedItems) {
      candidates.push(...toClipProjectItemCandidates(item, context.ppro));
    }
    return candidates;
  }
  async function getRootClipProjectItemCandidates(context) {
    const projectUtils = context.ppro?.ProjectUtils;
    if (!projectUtils || typeof projectUtils.getRootItem !== "function") {
      return [];
    }
    const root = await projectUtils.getRootItem(context.project);
    if (!root || typeof root.getItems !== "function") {
      return [];
    }
    const queue = await root.getItems();
    const candidates = [];
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) {
        continue;
      }
      const folder = context.ppro?.FolderItem?.cast?.(item);
      if (folder && typeof folder.getItems === "function") {
        const children = await folder.getItems();
        queue.push(...children);
        continue;
      }
      const clipCandidates = toClipProjectItemCandidates(item, context.ppro);
      if (clipCandidates.length > 0) {
        candidates.push(...clipCandidates);
      }
    }
    return candidates;
  }
  async function normalizeSelectionItems(selection) {
    if (Array.isArray(selection)) {
      return selection;
    }
    if (typeof selection?.getItems === "function") {
      const items = await selection.getItems();
      if (Array.isArray(items)) {
        return items;
      }
    }
    if (typeof selection?.getClipProjectItems === "function") {
      const clipItems = await selection.getClipProjectItems();
      if (Array.isArray(clipItems)) {
        return clipItems;
      }
    }
    return [];
  }
  function toClipProjectItemCandidates(item, ppro) {
    const candidates = [];
    if (item) {
      candidates.push(item);
    }
    const cast = ppro?.ClipProjectItem?.cast;
    if (typeof cast === "function") {
      try {
        const castItem = cast(item);
        if (castItem) {
          candidates.unshift(castItem);
        }
      } catch {
      }
    }
    return candidates;
  }
  function parseTranscriptJson(raw) {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.segments)) {
      throw new Error("Transcript JSON did not contain segments[].");
    }
    return parsed;
  }
  function composeTranscriptText(words) {
    let text = "";
    for (const word of words) {
      const token = typeof word.text === "string" ? word.text : "";
      if (!token) {
        continue;
      }
      if (!text) {
        text = token;
        continue;
      }
      const tokenType = typeof word.type === "string" ? word.type : "";
      if (tokenType.toLowerCase() === "punctuation" || /^[,.;:!?)]/.test(token) || /^[’']/.test(token)) {
        text += token;
      } else {
        text += ` ${token}`;
      }
    }
    return text.replace(/\s+([,.;:!?])/g, "$1").trim();
  }
  function tokenizeTranscriptText(text) {
    const tokens = text.match(/[^\s]+/g);
    return tokens ? [...tokens] : [];
  }
  function applyCorrectionToWords(originalWords, correctedText) {
    const textWordIndices = [];
    const originalTokens = [];
    for (let index = 0; index < originalWords.length; index += 1) {
      const token = typeof originalWords[index]?.text === "string" ? originalWords[index].text ?? "" : "";
      if (!token) {
        continue;
      }
      textWordIndices.push(index);
      originalTokens.push(token);
    }
    const tokens = tokenizeTranscriptText(correctedText);
    if (tokens.length === 0 || originalTokens.length === 0) {
      return void 0;
    }
    if (tokens.length === originalTokens.length) {
      return applyTokenStableCorrection(originalWords, textWordIndices, tokens);
    }
    return void 0;
  }
  function applyTokenStableCorrection(originalWords, textWordIndices, tokens) {
    const nextWords = cloneWords(originalWords);
    for (let slot = 0; slot < textWordIndices.length; slot += 1) {
      const wordIndex = textWordIndices[slot];
      const originalToken = typeof originalWords[wordIndex]?.text === "string" ? originalWords[wordIndex]?.text ?? "" : "";
      const token = tokens[slot] ?? "";
      const originalIsPunctuation = isPunctuationToken(originalToken);
      const replacementIsPunctuation = isPunctuationToken(token);
      if (originalIsPunctuation !== replacementIsPunctuation) {
        return void 0;
      }
      nextWords[wordIndex] = { ...nextWords[wordIndex], text: token };
    }
    return nextWords;
  }
  function rewriteWordsWithTiming(originalWords, correctedText) {
    const correctedTokens = tokenizeTranscriptText(correctedText);
    if (correctedTokens.length === 0) {
      return void 0;
    }
    const originalGroups = buildTimedTokenGroups(originalWords);
    if (originalGroups.length === 0) {
      return void 0;
    }
    const alignment = alignCorrectedTokensToOriginalTiming(originalGroups, correctedTokens);
    const averageConfidenceValue = averageGroupConfidence(originalGroups);
    const segmentStart = originalGroups[0].start;
    const segmentEnd = originalGroups.reduce((max2, group) => Math.max(max2, group.end), originalGroups[0].end);
    if (!alignment.some((op) => op.correctedToken && op.original)) {
      return interpolateInsertedTokens(correctedTokens, segmentStart, segmentEnd, averageConfidenceValue).map((word, index, words) => ({
        ...word,
        eos: index === words.length - 1
      }));
    }
    const outputWords = [];
    for (let index = 0; index < alignment.length; index += 1) {
      const op = alignment[index];
      if (!op.correctedToken) {
        continue;
      }
      if (op.original) {
        outputWords.push(wordFromTimedToken(op.correctedToken, op.original, op.original.confidence ?? averageConfidenceValue));
        continue;
      }
      const insertedRunEnd = findInsertedRunEnd(alignment, index);
      const insertedTokens = alignment.slice(index, insertedRunEnd).map((entry) => entry.correctedToken).filter(isString);
      outputWords.push(
        ...interpolateInsertedTokens(
          insertedTokens,
          previousAnchoredEnd(outputWords, segmentStart),
          nextAnchoredStart(alignment, insertedRunEnd, segmentEnd),
          averageConfidenceValue
        )
      );
      index = insertedRunEnd - 1;
    }
    if (outputWords.length === 0) {
      return void 0;
    }
    return outputWords.map((word, index) => ({
      ...word,
      eos: index === outputWords.length - 1
    }));
  }
  function buildTimedTokenGroups(words) {
    const groups = [];
    let current;
    let confidenceSum = 0;
    let confidenceCount = 0;
    const closeCurrent = () => {
      if (!current) {
        return;
      }
      groups.push({
        ...current,
        confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : current.confidence
      });
      current = void 0;
      confidenceSum = 0;
      confidenceCount = 0;
    };
    for (const word of words) {
      const token = typeof word.text === "string" ? word.text.trim() : "";
      if (!token || typeof word.start !== "number" || typeof word.duration !== "number") {
        continue;
      }
      const start = word.start;
      const end = word.start + Math.max(0, word.duration);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        continue;
      }
      const tokenType = typeof word.type === "string" ? word.type.toLowerCase() : "";
      const attachesToPrevious = Boolean(current) && (tokenType === "punctuation" || isPunctuationToken(token) || /^[,.;:!?)]/.test(token) || /^[’']/.test(token));
      if (!attachesToPrevious) {
        closeCurrent();
        current = {
          confidence: word.confidence,
          end: Math.max(end, start),
          start,
          text: token
        };
      } else if (current) {
        current.text += token;
        current.end = Math.max(current.end, end);
      }
      if (typeof word.confidence === "number" && Number.isFinite(word.confidence)) {
        confidenceSum += word.confidence;
        confidenceCount += 1;
      }
    }
    closeCurrent();
    return groups.filter((group) => group.end >= group.start);
  }
  function alignCorrectedTokensToOriginalTiming(originalGroups, correctedTokens) {
    const originalCount = originalGroups.length;
    const correctedCount = correctedTokens.length;
    const gapPenalty = -2;
    const scores = Array.from({ length: originalCount + 1 }, () => Array(correctedCount + 1).fill(0));
    const trace = Array.from({ length: originalCount + 1 }, () => Array(correctedCount + 1).fill("diag"));
    for (let originalIndex2 = 1; originalIndex2 <= originalCount; originalIndex2 += 1) {
      scores[originalIndex2][0] = scores[originalIndex2 - 1][0] + gapPenalty;
      trace[originalIndex2][0] = "delete";
    }
    for (let correctedIndex2 = 1; correctedIndex2 <= correctedCount; correctedIndex2 += 1) {
      scores[0][correctedIndex2] = scores[0][correctedIndex2 - 1] + gapPenalty;
      trace[0][correctedIndex2] = "insert";
    }
    for (let originalIndex2 = 1; originalIndex2 <= originalCount; originalIndex2 += 1) {
      for (let correctedIndex2 = 1; correctedIndex2 <= correctedCount; correctedIndex2 += 1) {
        const similarity = tokenSimilarity(originalGroups[originalIndex2 - 1].text, correctedTokens[correctedIndex2 - 1]);
        const diagonal = scores[originalIndex2 - 1][correctedIndex2 - 1] + similarity;
        const deletion = scores[originalIndex2 - 1][correctedIndex2] + gapPenalty;
        const insertion = scores[originalIndex2][correctedIndex2 - 1] + gapPenalty;
        if (diagonal >= deletion && diagonal >= insertion) {
          scores[originalIndex2][correctedIndex2] = diagonal;
          trace[originalIndex2][correctedIndex2] = "diag";
        } else if (deletion >= insertion) {
          scores[originalIndex2][correctedIndex2] = deletion;
          trace[originalIndex2][correctedIndex2] = "delete";
        } else {
          scores[originalIndex2][correctedIndex2] = insertion;
          trace[originalIndex2][correctedIndex2] = "insert";
        }
      }
    }
    const ops = [];
    let originalIndex = originalCount;
    let correctedIndex = correctedCount;
    while (originalIndex > 0 || correctedIndex > 0) {
      const op = trace[originalIndex][correctedIndex];
      if (originalIndex > 0 && correctedIndex > 0 && op === "diag") {
        const original = originalGroups[originalIndex - 1];
        const correctedToken = correctedTokens[correctedIndex - 1];
        if (tokenSimilarity(original.text, correctedToken) > 0) {
          ops.push({ correctedToken, original });
        } else {
          ops.push({ correctedToken });
          ops.push({ original });
        }
        originalIndex -= 1;
        correctedIndex -= 1;
        continue;
      }
      if (originalIndex > 0 && (correctedIndex === 0 || op === "delete")) {
        ops.push({ original: originalGroups[originalIndex - 1] });
        originalIndex -= 1;
        continue;
      }
      if (correctedIndex > 0) {
        ops.push({ correctedToken: correctedTokens[correctedIndex - 1] });
        correctedIndex -= 1;
      }
    }
    return ops.reverse();
  }
  function tokenSimilarity(original, corrected) {
    if (original === corrected) {
      return 8;
    }
    const originalKey = normalizeTokenForAlignment(original);
    const correctedKey = normalizeTokenForAlignment(corrected);
    if (!originalKey || !correctedKey) {
      return -5;
    }
    if (originalKey === correctedKey) {
      return 7;
    }
    const distance = levenshteinDistance(originalKey, correctedKey, 3);
    const maxLength = Math.max(originalKey.length, correctedKey.length);
    if (distance === 1 && maxLength >= 4) {
      return 5;
    }
    if (distance === 2 && maxLength >= 7) {
      return 3;
    }
    if (distance <= 3 && maxLength >= 10) {
      return 2;
    }
    return -5;
  }
  function normalizeTokenForAlignment(token) {
    return token.toLocaleLowerCase("de-DE").normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}]/gu, "");
  }
  function levenshteinDistance(left, right, maxDistance) {
    if (Math.abs(left.length - right.length) > maxDistance) {
      return maxDistance + 1;
    }
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = [leftIndex];
      let rowMin = current[0];
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
        const value = Math.min(
          previous[rightIndex] + 1,
          current[rightIndex - 1] + 1,
          previous[rightIndex - 1] + substitutionCost
        );
        current[rightIndex] = value;
        rowMin = Math.min(rowMin, value);
      }
      if (rowMin > maxDistance) {
        return maxDistance + 1;
      }
      previous = current;
    }
    return previous[right.length];
  }
  function wordFromTimedToken(token, timing, confidence) {
    return {
      confidence,
      duration: Math.max(0, timing.end - timing.start),
      eos: false,
      start: timing.start,
      text: token,
      type: isPunctuationToken(token) ? "punctuation" : "word"
    };
  }
  function findInsertedRunEnd(alignment, startIndex) {
    let index = startIndex;
    while (index < alignment.length && alignment[index].correctedToken && !alignment[index].original) {
      index += 1;
    }
    return index;
  }
  function previousAnchoredEnd(outputWords, fallback) {
    for (let index = outputWords.length - 1; index >= 0; index -= 1) {
      const word = outputWords[index];
      if (typeof word.start === "number" && typeof word.duration === "number") {
        return word.start + Math.max(0, word.duration);
      }
    }
    return fallback;
  }
  function nextAnchoredStart(alignment, startIndex, fallback) {
    for (let index = startIndex; index < alignment.length; index += 1) {
      const original = alignment[index].original;
      if (original && alignment[index].correctedToken) {
        return original.start;
      }
    }
    return fallback;
  }
  function interpolateInsertedTokens(tokens, start, end, confidence) {
    if (tokens.length === 0) {
      return [];
    }
    const span = Math.max(0, end - start);
    const weights = tokens.map(tokenTimingWeight);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const fallbackDuration = span > 0 ? span / tokens.length : 0;
    let cursor = start;
    let consumedWeight = 0;
    return tokens.map((token, index) => {
      consumedWeight += weights[index];
      const nextCursor = span > 0 && totalWeight > 0 ? start + span * consumedWeight / totalWeight : cursor + fallbackDuration;
      const duration = Math.max(0, nextCursor - cursor);
      const word = {
        confidence,
        duration,
        eos: false,
        start: cursor,
        text: token,
        type: isPunctuationToken(token) ? "punctuation" : "word"
      };
      cursor = nextCursor;
      return word;
    });
  }
  function tokenTimingWeight(token) {
    const letters = token.replace(/[^\p{L}\p{M}\p{N}]/gu, "").length;
    return Math.max(1, letters);
  }
  function averageGroupConfidence(groups) {
    const values = groups.map((group) => group.confidence).filter((value) => typeof value === "number" && Number.isFinite(value));
    if (values.length === 0) {
      return 1;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  function isString(value) {
    return typeof value === "string";
  }
  function hasUsableTiming(words) {
    return words.length > 0 && words.every((word) => typeof word.start === "number" && typeof word.duration === "number");
  }
  function groupBySegment(issues) {
    const groups = /* @__PURE__ */ new Map();
    for (const issue of issues) {
      const index = issue.target.native?.transcriptSegmentIndex;
      if (typeof index !== "number") {
        continue;
      }
      const current = groups.get(index) ?? [];
      current.push(issue);
      groups.set(index, current);
    }
    return groups;
  }
  function createTranscriptImportAction(ppro, textSegments, candidates, logger) {
    const errors = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        const action = ppro.Transcript.createImportTextSegmentsAction(textSegments, candidate);
        if (action) {
          return { action, errorMessage: "" };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ index, message });
        logger.warn("Transcript import action failed for candidate project item.", { index, message });
      }
    }
    if (errors.length > 0) {
      return {
        errorMessage: `Transcript import action failed on all candidates: ${errors.map((entry) => entry.message).join(" | ")}`
      };
    }
    return { errorMessage: "Transcript import action could not be created." };
  }
  function tryImportTranscript(context, transcript, candidates, logger, segmentIndex) {
    const importAttempt = () => {
      try {
        const textSegments = context.ppro.Transcript.importFromJSON(JSON.stringify(transcript));
        const actionResult = createTranscriptImportAction(context.ppro, textSegments, candidates, logger);
        if (!actionResult.action) {
          return { success: false, errorMessage: actionResult.errorMessage };
        }
        const success = context.project.executeTransaction((compoundAction) => {
          compoundAction.addAction(actionResult.action);
        }, "Subtitle QA: Apply transcript cleanup");
        if (success === false) {
          return { success: false, errorMessage: "Transcript transaction returned false." };
        }
        return { success: true, errorMessage: "" };
      } catch (error) {
        return {
          success: false,
          errorMessage: error instanceof Error ? error.message : String(error)
        };
      }
    };
    if (typeof context.project?.lockedAccess !== "function") {
      return importAttempt();
    }
    try {
      let result;
      context.project.lockedAccess(() => {
        result = importAttempt();
      });
      if (!result) {
        return { success: false, errorMessage: "Transcript transaction returned no result." };
      }
      return result;
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (typeof segmentIndex === "number") {
        logger.info("Transcript segment apply attempt complete.", { segmentIndex });
      }
    }
  }
  function applyPlansToTranscript(transcript, plans) {
    const segments = transcript.segments ?? [];
    for (const plan of plans) {
      const segment = segments[plan.segmentIndex];
      if (!segment || !Array.isArray(segment.words)) {
        return false;
      }
      segment.words = cloneWords(plan.updatedWords);
    }
    return true;
  }
  function cloneTranscript(transcript) {
    const segments = Array.isArray(transcript.segments) ? transcript.segments.map((segment) => ({
      ...segment,
      words: Array.isArray(segment.words) ? cloneWords(segment.words) : segment.words
    })) : transcript.segments;
    return { ...transcript, segments };
  }
  function cloneWords(words) {
    return words.map((word) => ({ ...word }));
  }
  function isPunctuationToken(token) {
    return /^[,.;:!?'"“”‘’()\-–—/…]+$/.test(token);
  }
  function dedupeObjects(values) {
    const seen = /* @__PURE__ */ new Set();
    const next = [];
    for (const value of values) {
      if (!seen.has(value)) {
        seen.add(value);
        next.push(value);
      }
    }
    return next;
  }
  function methodNames(value) {
    if (!value) {
      return [];
    }
    const names = /* @__PURE__ */ new Set();
    let current = value;
    while (current && current !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(current)) {
        if (name !== "constructor" && typeof value?.[name] === "function") {
          names.add(name);
        }
      }
      current = Object.getPrototypeOf(current);
    }
    return [...names];
  }
  function hashString2(value) {
    let hash = 5381;
    for (let index = 0; index < value.length; index += 1) {
      hash = hash * 33 ^ value.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
  }
  function sameTranscriptText(left, right) {
    return normalizeTranscriptText(left) === normalizeTranscriptText(right);
  }
  function normalizeTranscriptText(value) {
    return value.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  }

  // src/ui/panel.ts
  var CENTRAL_GLOSSARY_SHAREPOINT_URL = "https://contentkueche.sharepoint.com/sites/contentkueche/Freigegebene%20Dokumente/General/00_COMPANY_BRAIN/subtitle-qa-glossary.json";
  var SubtitleQAPanel = class {
    constructor(root) {
      this.root = root;
      this.logger = new Logger();
      this.fs = new UxpFileSystem(this.logger);
      this.fallback = new ProjectFileFallback(this.fs, this.logger);
      this.transcriptApi = new TranscriptApiBridge(this.logger);
      this.mockEngine = new MockCorrectionEngine();
      this.openAiTranscriptCleanup = new OpenAiTranscriptCleanupEngine();
      this.applier = new FixApplier(this.fs, this.fallback, this.transcriptApi, this.logger);
      this.glossary = defaultGlossary;
      this.glossarySettings = defaultGlossarySettings();
      this.openAiSettings = defaultOpenAiSpellingSettings();
      this.scanLanguage = "auto";
      this.scanRunKey = createScanRunKey();
      this.reviewedDisplayKeys = /* @__PURE__ */ new Set();
      this.glossaryLoaded = false;
      this.glossarySettingsLoaded = false;
      this.bindEvents();
      this.hydrateEngineSettingsUi();
      this.setEngineSettingsPanelVisible(false);
      this.setGlossaryEditorVisible(false);
      this.logger.onChange(() => {
        this.setDebugLogText(this.logger.toText());
      });
      void this.ensureGlossaryLoaded(true);
      void this.loadEngineSettings();
      this.renderGlossaryEditor();
      this.render();
    }
    bindEvents() {
      this.cleanTranscriptButton.addEventListener("click", () => this.cleanTranscript());
      this.emptyTranscriptButton.addEventListener("click", () => this.cleanTranscript());
      this.acceptAllButton.addEventListener("click", () => this.setAll("accepted"));
      this.rejectAllButton.addEventListener("click", () => this.setAll("rejected"));
      this.applyButton.addEventListener("click", () => this.applyAccepted());
      this.loadGlossaryButton.addEventListener("click", () => this.openGlossaryEditor());
      this.glossaryCloseButton.addEventListener("click", () => this.setGlossaryEditorVisible(false));
      this.glossaryAddButton.addEventListener("click", () => this.addGlossaryTerm());
      this.glossarySaveButton.addEventListener("click", () => this.saveGlossaryEditor());
      this.glossaryImportButton.addEventListener("click", () => this.importGlossaryJson());
      this.glossaryPreferredInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          this.addGlossaryTerm();
        }
      });
      this.languageMode.addEventListener("change", () => this.onLanguageChanged());
      this.spellingEngineMode.addEventListener("change", () => this.onSpellingModeChanged());
      this.saveOpenAiSettingsButton.addEventListener("click", () => this.saveOpenAiSettings());
      this.toggleEngineSettingsButton.addEventListener("click", () => this.toggleEngineSettings());
      this.selectDebugButton.addEventListener("click", () => this.selectDebug());
      this.issuesTab.addEventListener("click", () => this.showTab("issues"));
      this.debugTab.addEventListener("click", () => this.showTab("debug"));
    }
    async cleanTranscript() {
      await this.runTranscriptCheck();
    }
    async runTranscriptCheck() {
      this.setBusy(true, "Checking transcript with OpenAI...");
      this.logger.clear();
      this.reviewedDisplayKeys.clear();
      this.scanRunKey = createScanRunKey();
      try {
        const context = await getPremiereContext(this.logger);
        this.context = context;
        const targets = await this.loadTranscriptTargets(context);
        const issues = await this.checkIssues(targets);
        this.scanResult = {
          projectName: context.projectName,
          projectPath: context.projectPath,
          sequenceName: context.sequenceName,
          capability: context.capability,
          targets,
          issues
        };
        if (targets.length === 0) {
          this.statusText.textContent = "Transcript cleanup unsupported in this project format. Open Debug for details.";
          this.logger.warn("Transcript cleanup unsupported.", context.capability);
        } else {
          const writableIssues = issues.filter((issue) => isWritableIssue(issue)).length;
          const reviewOnlyIssues = issues.length - writableIssues;
          this.statusText.textContent = `Found ${issues.length} issue${issues.length === 1 ? "" : "s"} in ${targets.length} text item${targets.length === 1 ? "" : "s"} (${languageLabel(this.scanLanguage)} / OpenAI Transcript)${reviewOnlyIssues > 0 ? `, ${writableIssues} writable` : ""}.`;
        }
      } catch (error) {
        this.statusText.textContent = "Scan failed. Open Debug for details.";
        this.logger.error("Scan failed.", serializeError(error));
      } finally {
        this.setBusy(false);
        this.render();
      }
    }
    async loadTranscriptTargets(context) {
      if (!context.projectPath) {
        context.capability.projectFileFallback = "unavailable";
        context.capability.notes.push("Transcript cleanup needs a saved project file path.");
        return [];
      }
      this.logger.info("Scanning transcript data from project file.");
      try {
        if (typeof context.project?.save === "function") {
          this.logger.info("Saving active project before transcript scan.");
          await context.project.save();
        }
        try {
          const apiTargets = await this.transcriptApi.scan(context);
          if (apiTargets.length > 0) {
            context.capability.projectFileFallback = "not-needed";
            context.capability.notes.push("Using official Transcript API for full transcript cleanup.");
            const captionGenerationApis = this.transcriptApi.detectCaptionGenerationApis(context);
            if (captionGenerationApis.length > 0) {
              context.capability.notes.push(`Detected possible caption-generation APIs: ${captionGenerationApis.join(", ")}`);
              this.logger.info("Detected possible caption-generation APIs.", { methods: captionGenerationApis });
            } else {
              context.capability.notes.push(
                "No public caption-generation API was detected in this Premiere UXP build; cleaned transcript import is supported, automatic subtitle generation is not yet exposed."
              );
              this.logger.warn("No public caption-generation API detected in this Premiere UXP build.");
            }
            return apiTargets;
          }
          this.logger.warn("Official Transcript API did not return text segments; falling back to project-file transcript scan.");
        } catch (error) {
          this.logger.warn("Official Transcript API scan failed; falling back to project-file transcript scan.", serializeError(error));
        }
        try {
          const transcriptTargets = await this.fallback.scanTranscript(context.projectPath, context.sequenceName);
          if (transcriptTargets.length > 0) {
            context.capability.projectFileFallback = "available";
            context.capability.notes.push("Using project-file transcript blocks as fallback for transcript cleanup.");
            this.logger.info("Using project-file transcript targets for cleanup.", {
              targets: transcriptTargets.length
            });
            return transcriptTargets;
          }
        } catch (error) {
          this.logger.warn("Project-file transcript fallback scan failed.", serializeError(error));
        }
        context.capability.projectFileFallback = "unavailable";
        context.capability.notes.push("Project-file transcript scan did not find writable transcript blocks.");
        this.logger.warn("TranscriptData not writable in this project; subtitle/caption fallback is disabled in transcript-only mode.");
        return [];
      } catch (error) {
        context.capability.projectFileFallback = "unavailable";
        context.capability.notes.push(error instanceof Error ? error.message : String(error));
        this.logger.warn("Project-file transcript scan failed.", serializeError(error));
        return [];
      }
    }
    async applyAccepted() {
      if (!this.scanResult || !this.context) {
        return;
      }
      this.setBusy(true, "Applying accepted fixes...");
      try {
        const acceptedBeforeApply = this.scanResult.issues.filter((issue) => issue.status === "accepted");
        const writableAcceptedBeforeApply = acceptedBeforeApply.filter((issue) => isWritableIssue(issue));
        const reviewOnlyAcceptedBeforeApply = acceptedBeforeApply.filter((issue) => !isWritableIssue(issue));
        if (acceptedBeforeApply.length === 0) {
          this.statusText.textContent = "No accepted issues to apply.";
          return;
        }
        let backupPath;
        let appliedWritable = 0;
        if (writableAcceptedBeforeApply.length > 0) {
          const writableResult = await this.applier.apply(this.context, writableAcceptedBeforeApply, { backupReuseKey: this.scanRunKey });
          appliedWritable = writableResult.appliedCount;
          backupPath = writableResult.backupPath;
          if (appliedWritable >= writableAcceptedBeforeApply.length) {
            for (const issue of writableAcceptedBeforeApply) {
              issue.status = "applied";
            }
          } else {
            this.logger.warn("Apply was partial; some accepted writable issues remain for review.", {
              accepted: writableAcceptedBeforeApply.length,
              applied: appliedWritable
            });
          }
        }
        if (reviewOnlyAcceptedBeforeApply.length > 0) {
          this.logManualApplyQueue(reviewOnlyAcceptedBeforeApply);
        }
        const totalApplied = appliedWritable;
        const remainingManual = reviewOnlyAcceptedBeforeApply.length;
        if (totalApplied === 0) {
          this.statusText.textContent = reviewOnlyAcceptedBeforeApply.length > 0 ? `Accepted ${reviewOnlyAcceptedBeforeApply.length} review-only issue${reviewOnlyAcceptedBeforeApply.length === 1 ? "" : "s"}. Auto-apply skipped because Premiere requires token-stable transcript edits.` : "Apply finished, but no accepted fixes could be written.";
        } else {
          this.statusText.textContent = `Applied ${totalApplied} accepted fix${totalApplied === 1 ? "" : "es"}${backupPath ? ` (backup: ${backupPath})` : ""}.` + (remainingManual > 0 ? ` ${remainingManual} accepted review-only issue${remainingManual === 1 ? "" : "s"} still need manual apply.` : "");
        }
        this.logger.info("Apply complete.", {
          appliedCount: totalApplied,
          appliedWritable,
          appliedReviewOnly: 0,
          remainingManual,
          backupPath
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.statusText.textContent = `Apply failed: ${message}`;
        this.logger.error("Apply failed.", serializeError(error));
      } finally {
        this.setBusy(false);
        this.render();
      }
    }
    async openGlossaryEditor() {
      await this.ensureGlossaryLoaded(false);
      this.renderGlossaryEditor();
      this.setGlossaryEditorVisible(true);
      this.statusText.textContent = `Glossary editor opened (${this.glossary.brandTerms.length} terms).`;
    }
    async ensureGlossaryLoaded(silent) {
      if (this.glossaryLoaded) {
        return;
      }
      const defaultJson = `${JSON.stringify(defaultGlossary, null, 2)}
`;
      try {
        await this.ensureGlossarySettingsLoaded();
        const shared = await this.loadSharedGlossaryIfAvailable();
        if (shared) {
          this.glossary = parseGlossaryJson(shared.text);
          this.glossaryLoaded = true;
          if (!silent) {
            this.statusText.textContent = `Loaded shared glossary: ${shared.name}`;
          }
          this.logger.info("Loaded shared glossary JSON.", {
            name: shared.name,
            terms: this.glossary.brandTerms.length,
            location: shared.location
          });
          return;
        }
        const standard = await this.fs.loadOrCreateStandardGlossary(defaultJson);
        this.glossary = parseGlossaryJson(standard.text);
        this.glossaryLoaded = true;
        if (!silent) {
          this.statusText.textContent = `Loaded standard glossary: ${standard.name}`;
        }
        this.logger.info("Loaded standard glossary JSON.", {
          name: standard.name,
          terms: this.glossary.brandTerms.length,
          location: standard.location ?? "plugin-data"
        });
      } catch (error) {
        this.glossary = defaultGlossary;
        this.glossaryLoaded = true;
        if (!silent) {
          this.statusText.textContent = "Could not load standard glossary; using built-in defaults.";
        }
        this.logger.warn("Standard glossary load failed; using in-memory defaults.", serializeError(error));
      }
    }
    async ensureGlossarySettingsLoaded() {
      if (this.glossarySettingsLoaded) {
        return;
      }
      const defaultText = `${JSON.stringify(defaultGlossarySettings(), null, 2)}
`;
      try {
        const loaded = await this.fs.loadOrCreateGlossarySettings(defaultText);
        this.glossarySettings = parseGlossarySettings(loaded.text);
        this.glossarySettingsLoaded = true;
        this.logger.info("Loaded glossary settings.", {
          sharedPath: this.glossarySettings.sharedPath ?? "",
          sharePointUrl: this.glossarySettings.sharePointUrl
        });
      } catch (error) {
        this.glossarySettings = defaultGlossarySettings();
        this.glossarySettingsLoaded = true;
        this.logger.warn("Could not load glossary settings; using defaults.", serializeError(error));
      }
    }
    async loadSharedGlossaryIfAvailable() {
      if (this.glossarySettings.sharedPath) {
        try {
          return {
            name: "subtitle-qa-glossary.json",
            text: await this.fs.readTextFile(this.glossarySettings.sharedPath),
            location: this.glossarySettings.sharedPath
          };
        } catch (error) {
          this.logger.warn("Configured shared glossary path could not be read; trying auto-discovery.", {
            sharedPath: this.glossarySettings.sharedPath,
            ...serializeError(error)
          });
        }
      }
      const discoveredPath = await this.fs.findSharedGlossaryPath();
      if (!discoveredPath) {
        return void 0;
      }
      this.glossarySettings = { ...this.glossarySettings, sharedPath: discoveredPath };
      await this.saveGlossarySettings();
      return {
        name: "subtitle-qa-glossary.json",
        text: await this.fs.readTextFile(discoveredPath),
        location: discoveredPath
      };
    }
    addGlossaryTerm() {
      const term = this.glossaryTermInput.value.trim();
      const preferred = this.glossaryPreferredInput.value.trim();
      if (!term || !preferred) {
        this.statusText.textContent = "Glossary term and preferred value are required.";
        return;
      }
      const languageRaw = this.glossaryLanguageInput.value;
      const language = languageRaw === "de" || languageRaw === "en" ? languageRaw : void 0;
      const note = this.glossaryNoteInput.value.trim();
      const caseSensitive = this.glossaryCaseSensitiveInput.checked;
      const duplicateIndex = this.glossary.brandTerms.findIndex(
        (entry) => entry.term.toLowerCase() === term.toLowerCase() && (entry.language ?? "all") === (language ?? "all") && entry.preferred.toLowerCase() === preferred.toLowerCase()
      );
      if (duplicateIndex >= 0) {
        this.statusText.textContent = "This glossary entry already exists.";
        return;
      }
      this.glossary = {
        brandTerms: [
          ...this.glossary.brandTerms,
          {
            term,
            preferred,
            language,
            caseSensitive,
            note: note.length > 0 ? note : void 0
          }
        ]
      };
      this.glossaryTermInput.value = "";
      this.glossaryPreferredInput.value = "";
      this.glossaryLanguageInput.value = "all";
      this.glossaryNoteInput.value = "";
      this.glossaryCaseSensitiveInput.checked = false;
      this.renderGlossaryEditor();
      this.statusText.textContent = `Added glossary term "${term}".`;
    }
    removeGlossaryTerm(index) {
      if (index < 0 || index >= this.glossary.brandTerms.length) {
        return;
      }
      const removed = this.glossary.brandTerms[index];
      this.glossary = {
        brandTerms: this.glossary.brandTerms.filter((_, current) => current !== index)
      };
      this.renderGlossaryEditor();
      this.statusText.textContent = `Removed glossary term "${removed.term}".`;
    }
    async saveGlossaryEditor() {
      try {
        await this.ensureGlossaryLoaded(true);
        const text = `${JSON.stringify(this.glossary, null, 2)}
`;
        await this.ensureGlossarySettingsLoaded();
        const saved = this.glossarySettings.sharedPath ? await this.saveSharedGlossary(text) : await this.fs.saveStandardGlossary(text);
        this.statusText.textContent = `Saved ${this.glossarySettings.sharedPath ? "shared" : "local"} glossary (${this.glossary.brandTerms.length} terms).`;
        this.logger.info("Saved glossary JSON.", {
          name: saved.name,
          terms: this.glossary.brandTerms.length,
          location: saved.location ?? "plugin-data"
        });
      } catch (error) {
        this.statusText.textContent = "Glossary save failed. Open Debug for details.";
        this.logger.error("Glossary save failed.", serializeError(error));
      }
    }
    async importGlossaryJson() {
      try {
        const picked = await this.fs.pickJsonTextFile();
        if (!picked) {
          return;
        }
        this.glossary = parseGlossaryJson(picked.text);
        this.glossaryLoaded = true;
        if (picked.path) {
          await this.ensureGlossarySettingsLoaded();
          this.glossarySettings = { ...this.glossarySettings, sharedPath: picked.path };
          await this.saveGlossarySettings();
        }
        this.renderGlossaryEditor();
        this.statusText.textContent = picked.path ? `Linked shared glossary: ${picked.name}` : `Imported glossary: ${picked.name}`;
        this.logger.info("Imported glossary JSON from picker.", {
          name: picked.name,
          terms: this.glossary.brandTerms.length,
          location: picked.location ?? "picker"
        });
      } catch (error) {
        this.statusText.textContent = "Glossary import failed. Open Debug for details.";
        this.logger.error("Glossary import failed.", serializeError(error));
      }
    }
    async saveSharedGlossary(text) {
      const sharedPath = this.glossarySettings.sharedPath;
      if (!sharedPath) {
        throw new Error("No shared glossary path is configured.");
      }
      await this.fs.writeTextFile(sharedPath, text);
      return { name: "subtitle-qa-glossary.json", location: sharedPath };
    }
    async saveGlossarySettings() {
      const text = `${JSON.stringify(this.glossarySettings, null, 2)}
`;
      await this.fs.saveGlossarySettings(text);
    }
    setGlossaryEditorVisible(visible) {
      this.glossaryEditor.classList.toggle("visible", visible);
      this.loadGlossaryButton.textContent = visible ? "Glossary (Open)" : "Glossary";
    }
    renderGlossaryEditor() {
      clearChildren(this.glossaryList);
      if (this.glossary.brandTerms.length === 0) {
        const row = this.root.createElement("div");
        row.className = "glossary-row";
        row.textContent = "No glossary terms yet.";
        this.glossaryList.appendChild(row);
        return;
      }
      for (let index = 0; index < this.glossary.brandTerms.length; index += 1) {
        const term = this.glossary.brandTerms[index];
        const row = this.root.createElement("div");
        row.className = "glossary-row";
        const source = this.root.createElement("span");
        source.className = "glossary-row-source";
        source.textContent = term.term;
        const preferred = this.root.createElement("span");
        preferred.className = "glossary-row-preferred";
        preferred.textContent = term.preferred;
        const language = this.root.createElement("span");
        language.className = "glossary-tag";
        language.textContent = term.language ?? "all";
        const caseTag = this.root.createElement("span");
        caseTag.className = "glossary-tag";
        caseTag.textContent = term.caseSensitive ? "case" : "no-case";
        const remove = this.root.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => this.removeGlossaryTerm(index));
        row.append(source, preferred, language, caseTag, remove);
        this.glossaryList.appendChild(row);
      }
    }
    onLanguageChanged() {
      const selected = this.languageMode.value;
      if (selected === "de" || selected === "en" || selected === "auto") {
        this.scanLanguage = selected;
        this.statusText.textContent = `Language set to ${languageLabel(this.scanLanguage)}.`;
        this.logger.info("Updated scan language mode.", { language: this.scanLanguage });
      }
    }
    async checkIssues(targets) {
      const localIssues = dedupeIssues(this.mockEngine.checkTargets(targets, this.glossary, this.scanLanguage));
      try {
        const cleanupIssues = dedupeIssues(
          await this.openAiTranscriptCleanup.cleanTargets(targets, this.scanLanguage, this.openAiSettings, this.glossary)
        );
        this.logger.info("OpenAI full transcript cleanup complete.", {
          mode: "openai_full_transcript",
          targets: targets.length,
          cleanupIssues: cleanupIssues.length
        });
        return cleanupIssues;
      } catch (error) {
        this.logger.warn("OpenAI full transcript cleanup failed; using local fallback.", serializeError(error));
        this.statusText.textContent = "OpenAI transcript cleanup failed; used local fallback.";
        return localIssues;
      }
    }
    onSpellingModeChanged() {
      const selected = this.spellingEngineMode.value;
      if (selected === "local" || selected === "openai" || selected === "openai_full") {
        this.openAiSettings.mode = selected;
        this.toggleOpenAiInputs(selected !== "local");
        this.statusText.textContent = `Transcript engine set to ${spellingModeLabel(selected)}. Save to persist.`;
      }
    }
    async loadEngineSettings() {
      const defaults = defaultOpenAiSpellingSettings();
      const defaultText = `${JSON.stringify(defaults, null, 2)}
`;
      try {
        const loaded = await this.fs.loadOrCreateEngineSettings(defaultText);
        const parsed = parseOpenAiSpellingSettings(loaded.text, defaults);
        this.openAiSettings = parsed;
        this.hydrateEngineSettingsUi();
        this.toggleOpenAiInputs(this.openAiSettings.mode !== "local");
        this.logger.info("Loaded transcript engine settings.", {
          mode: this.openAiSettings.mode,
          model: this.openAiSettings.model,
          location: loaded.location ?? "plugin-data"
        });
      } catch (error) {
        this.openAiSettings = defaults;
        this.hydrateEngineSettingsUi();
        this.toggleOpenAiInputs(false);
        this.logger.warn("Could not load transcript engine settings; using defaults.", serializeError(error));
      }
    }
    async saveOpenAiSettings() {
      try {
        this.openAiSettings = {
          mode: "openai_full",
          apiKey: this.openAiApiKey.value.trim(),
          model: this.openAiModel.value.trim() || "gpt-4.1-mini"
        };
        const text = `${JSON.stringify(this.openAiSettings, null, 2)}
`;
        const saved = await this.fs.saveEngineSettings(text);
        this.statusText.textContent = `Saved transcript engine settings (${spellingModeLabel(this.openAiSettings.mode)}).`;
        this.logger.info("Saved transcript engine settings.", {
          mode: this.openAiSettings.mode,
          model: this.openAiSettings.model,
          location: saved.location ?? "plugin-data"
        });
        this.setEngineSettingsPanelVisible(false);
      } catch (error) {
        this.statusText.textContent = "Could not save transcript engine settings. Open Debug for details.";
        this.logger.error("Saving transcript engine settings failed.", serializeError(error));
      }
    }
    toggleEngineSettings() {
      const shouldShow = !this.engineSettingsPanel.classList.contains("visible");
      this.setEngineSettingsPanelVisible(shouldShow);
    }
    setEngineSettingsPanelVisible(visible) {
      this.engineSettingsPanel.classList.toggle("visible", visible);
      this.toggleEngineSettingsButton.textContent = visible ? "Hide Engine Settings" : "Engine Settings";
    }
    hydrateEngineSettingsUi() {
      this.spellingEngineMode.value = this.openAiSettings.mode;
      this.openAiApiKey.value = this.openAiSettings.apiKey;
      this.openAiModel.value = this.openAiSettings.model;
      this.toggleOpenAiInputs(this.openAiSettings.mode !== "local");
    }
    toggleOpenAiInputs(enabled) {
      this.openAiApiKey.disabled = !enabled;
      this.openAiModel.disabled = !enabled;
    }
    setAll(status) {
      if (!this.scanResult) {
        return;
      }
      let changed = 0;
      for (const issue of this.scanResult.issues) {
        if (issue.status === "pending") {
          issue.status = status;
          this.reviewedDisplayKeys.add(issueDisplayKey(issue));
          changed += 1;
        }
      }
      if (changed > 0) {
        this.statusText.textContent = status === "accepted" ? `Accepted ${changed} pending fix${changed === 1 ? "" : "es"}. Click Apply Accepted to write them.` : `Rejected ${changed} pending issue${changed === 1 ? "" : "s"}.`;
      } else {
        this.statusText.textContent = "No pending issues changed.";
      }
      this.render();
    }
    setIssueStatus(issueId, status) {
      const issue = this.scanResult?.issues.find((item) => item.id === issueId);
      if (!issue || issue.status === "applied") {
        return;
      }
      issue.status = status;
      if (status === "pending") {
        this.reviewedDisplayKeys.delete(issueDisplayKey(issue));
      } else {
        this.reviewedDisplayKeys.add(issueDisplayKey(issue));
      }
      this.render();
    }
    render() {
      const allIssues = this.scanResult?.issues ?? [];
      const accepted = allIssues.filter((issue) => issue.status === "accepted").length;
      const reviewedIssues = allIssues.filter((issue) => issue.status === "accepted" || issue.status === "rejected");
      const visibleIssues = allIssues.filter(
        (issue) => issue.status === "pending" && !this.reviewedDisplayKeys.has(issueDisplayKey(issue))
      );
      this.issueCount.textContent = String(visibleIssues.length);
      this.acceptedCount.textContent = String(accepted);
      this.sourceMode.textContent = sourceMode(this.scanResult);
      this.setApplyButtonsDisabled(accepted === 0);
      clearChildren(this.issueList);
      this.emptyState.style.display = visibleIssues.length === 0 ? "block" : "none";
      this.setEmptyStateText(allIssues, visibleIssues, reviewedIssues);
      for (const issue of visibleIssues) {
        this.issueList.appendChild(this.renderIssue(issue));
      }
      if (reviewedIssues.length > 0) {
        const heading = this.root.createElement("li");
        heading.className = "issue-group-heading";
        heading.textContent = `Reviewed (${reviewedIssues.length})`;
        this.issueList.appendChild(heading);
        for (const issue of reviewedIssues) {
          this.issueList.appendChild(this.renderReviewedIssue(issue));
        }
      }
    }
    renderIssue(issue) {
      const item = this.root.createElement("li");
      item.className = "issue";
      const header = this.root.createElement("div");
      header.className = "issue-header";
      const title = this.root.createElement("div");
      title.className = "issue-title";
      title.textContent = `${labelForIssue(issue)} `;
      const target = this.root.createElement("span");
      target.textContent = issue.target.label;
      title.appendChild(target);
      const badge = this.root.createElement("span");
      badge.className = `badge ${issue.status}`;
      badge.textContent = issue.status;
      header.append(title, badge);
      const message = this.root.createElement("p");
      message.textContent = isWritableIssue(issue) ? issue.message : `${issue.message} ${nonWritableReason(issue)}`;
      const original = copyBlock(this.root, "Current", changedText(issue));
      const suggested = copyBlock(this.root, "Suggested", replacementText(issue));
      const context = this.root.createElement("div");
      context.className = "issue-context";
      context.textContent = contextSnippet(issue);
      const actions = this.root.createElement("div");
      actions.className = "issue-actions";
      const accept = this.root.createElement("button");
      accept.type = "button";
      accept.textContent = "Accept";
      accept.disabled = issue.status !== "pending";
      accept.addEventListener("click", () => this.setIssueStatus(issue.id, "accepted"));
      const reject = this.root.createElement("button");
      reject.type = "button";
      reject.textContent = "Reject";
      reject.disabled = issue.status !== "pending";
      reject.addEventListener("click", () => this.setIssueStatus(issue.id, "rejected"));
      actions.append(accept, reject);
      item.append(header, message, original, suggested, context, actions);
      return item;
    }
    renderReviewedIssue(issue) {
      const item = this.root.createElement("li");
      item.className = "issue reviewed";
      const header = this.root.createElement("div");
      header.className = "issue-header";
      const title = this.root.createElement("div");
      title.className = "issue-title";
      title.textContent = `${labelForIssue(issue)} `;
      const target = this.root.createElement("span");
      target.textContent = issue.target.label;
      title.appendChild(target);
      const badge = this.root.createElement("span");
      badge.className = `badge ${issue.status}`;
      badge.textContent = issue.status;
      header.append(title, badge);
      const message = this.root.createElement("p");
      message.textContent = issue.message;
      const original = copyBlock(this.root, "Current", changedText(issue));
      const suggested = copyBlock(this.root, "Suggested", replacementText(issue));
      const context = this.root.createElement("div");
      context.className = "issue-context";
      context.textContent = `${contextSnippet(issue)} | Decision can be changed before apply.`;
      const actions = this.root.createElement("div");
      actions.className = "issue-actions";
      const pending = this.root.createElement("button");
      pending.type = "button";
      pending.textContent = "Set Pending";
      pending.addEventListener("click", () => this.setIssueStatus(issue.id, "pending"));
      actions.appendChild(pending);
      if (issue.status === "accepted") {
        const reject = this.root.createElement("button");
        reject.type = "button";
        reject.textContent = "Reject";
        reject.addEventListener("click", () => this.setIssueStatus(issue.id, "rejected"));
        actions.appendChild(reject);
      } else {
        const accept = this.root.createElement("button");
        accept.type = "button";
        accept.textContent = "Accept";
        accept.addEventListener("click", () => this.setIssueStatus(issue.id, "accepted"));
        actions.appendChild(accept);
      }
      item.append(header, message, original, suggested, context, actions);
      return item;
    }
    showTab(tab) {
      this.issuesTab.classList.toggle("active", tab === "issues");
      this.debugTab.classList.toggle("active", tab === "debug");
      this.issuesView.classList.toggle("active", tab === "issues");
      this.debugView.classList.toggle("active", tab === "debug");
    }
    selectDebug() {
      try {
        this.debugLog.focus();
        this.debugLog.select();
        this.statusText.textContent = "Debug log selected. Press Cmd+C to copy it.";
      } catch (error) {
        this.statusText.textContent = "Could not select debug log.";
        this.logger.warn("Select debug log failed.", serializeError(error));
      }
    }
    setDebugLogText(text) {
      this.debugLog.value = text;
    }
    setEmptyStateText(allIssues, visibleIssues, reviewedIssues) {
      const message = this.emptyState.querySelector("p");
      if (!message) {
        return;
      }
      if (!this.scanResult || allIssues.length === 0) {
        message.textContent = "Run Check Transcript (OpenAI), review the suggested cleanup, then apply accepted fixes.";
      } else if (visibleIssues.length === 0 && reviewedIssues.length > 0) {
        message.textContent = "All pending issues are reviewed. Adjust decisions below or apply accepted fixes.";
      } else {
        message.textContent = "All pending issues are reviewed.";
      }
    }
    setBusy(isBusy, message) {
      this.cleanTranscriptButton.disabled = isBusy;
      this.emptyTranscriptButton.disabled = isBusy;
      this.loadGlossaryButton.disabled = isBusy;
      this.glossaryAddButton.disabled = isBusy;
      this.glossarySaveButton.disabled = isBusy;
      this.glossaryImportButton.disabled = isBusy;
      this.glossaryCloseButton.disabled = isBusy;
      this.setApplyButtonsDisabled(isBusy || (this.scanResult?.issues.filter((issue) => issue.status === "accepted").length ?? 0) === 0);
      if (message) {
        this.statusText.textContent = message;
      }
    }
    setApplyButtonsDisabled(disabled) {
      this.applyButton.disabled = disabled;
    }
    logManualApplyQueue(issues) {
      if (issues.length === 0) {
        return;
      }
      this.logger.warn("Accepted issues queued for manual apply (review-only in this source mode).", {
        count: issues.length,
        items: issues.slice(0, 25).map((issue) => ({
          id: issue.id,
          type: issue.type,
          target: issue.target.label,
          reason: nonWritableReason(issue),
          current: changedText(issue),
          suggested: replacementText(issue),
          context: contextSnippet(issue)
        }))
      });
    }
    get cleanTranscriptButton() {
      return getElement(this.root, "cleanTranscriptButton");
    }
    get emptyTranscriptButton() {
      return getElement(this.root, "emptyTranscriptButton");
    }
    get acceptAllButton() {
      return getElement(this.root, "acceptAllButton");
    }
    get rejectAllButton() {
      return getElement(this.root, "rejectAllButton");
    }
    get applyButton() {
      return getElement(this.root, "applyButton");
    }
    get loadGlossaryButton() {
      return getElement(this.root, "loadGlossaryButton");
    }
    get glossaryEditor() {
      return getElement(this.root, "glossaryEditor");
    }
    get glossaryList() {
      return getElement(this.root, "glossaryList");
    }
    get glossaryTermInput() {
      return getElement(this.root, "glossaryTermInput");
    }
    get glossaryPreferredInput() {
      return getElement(this.root, "glossaryPreferredInput");
    }
    get glossaryLanguageInput() {
      return getElement(this.root, "glossaryLanguageInput");
    }
    get glossaryCaseSensitiveInput() {
      return getElement(this.root, "glossaryCaseSensitiveInput");
    }
    get glossaryNoteInput() {
      return getElement(this.root, "glossaryNoteInput");
    }
    get glossaryAddButton() {
      return getElement(this.root, "glossaryAddButton");
    }
    get glossarySaveButton() {
      return getElement(this.root, "glossarySaveButton");
    }
    get glossaryImportButton() {
      return getElement(this.root, "glossaryImportButton");
    }
    get glossaryCloseButton() {
      return getElement(this.root, "glossaryCloseButton");
    }
    get languageMode() {
      return getElement(this.root, "languageMode");
    }
    get spellingEngineMode() {
      return getElement(this.root, "spellingEngineMode");
    }
    get openAiApiKey() {
      return getElement(this.root, "openAiApiKey");
    }
    get openAiModel() {
      return getElement(this.root, "openAiModel");
    }
    get saveOpenAiSettingsButton() {
      return getElement(this.root, "saveOpenAiSettingsButton");
    }
    get toggleEngineSettingsButton() {
      return getElement(this.root, "toggleEngineSettingsButton");
    }
    get engineSettingsPanel() {
      return getElement(this.root, "engineSettingsPanel");
    }
    get selectDebugButton() {
      return getElement(this.root, "selectDebugButton");
    }
    get issuesTab() {
      return getElement(this.root, "issuesTab");
    }
    get debugTab() {
      return getElement(this.root, "debugTab");
    }
    get issuesView() {
      return getElement(this.root, "issuesView");
    }
    get debugView() {
      return getElement(this.root, "debugView");
    }
    get issueList() {
      return getElement(this.root, "issueList");
    }
    get emptyState() {
      return getElement(this.root, "emptyState");
    }
    get debugLog() {
      return getElement(this.root, "debugLog");
    }
    get statusText() {
      return getElement(this.root, "statusText");
    }
    get issueCount() {
      return getElement(this.root, "issueCount");
    }
    get acceptedCount() {
      return getElement(this.root, "acceptedCount");
    }
    get sourceMode() {
      return getElement(this.root, "sourceMode");
    }
  };
  function copyBlock(document2, label, text) {
    const block = document2.createElement("div");
    block.className = "copy-block";
    const caption = document2.createElement("span");
    caption.className = "copy-label";
    caption.textContent = label;
    const content = document2.createElement("div");
    content.textContent = text;
    block.append(caption, content);
    return block;
  }
  function changedText(issue) {
    return issuePreview(issue, "before");
  }
  function replacementText(issue) {
    return issuePreview(issue, "after");
  }
  function displayChangeText(text, emptyLabel) {
    if (text.length === 0) {
      return emptyLabel;
    }
    if (/^\s+$/.test(text)) {
      return `${text.length} space${text.length === 1 ? "" : "s"}`;
    }
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }
  function issuePreview(issue, mode) {
    if (issue.ruleId === FULL_TRANSCRIPT_REWRITE_RULE_ID) {
      return displayChangeText(mode === "before" ? issue.originalText : issue.replacement.replacement, "(empty)");
    }
    const source = issue.originalText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const { start, end, replacement } = issue.replacement;
    const radius = 28;
    const leftStart = Math.max(0, start - radius);
    const rightEnd = Math.min(source.length, end + radius);
    const left = source.slice(leftStart, start).replace(/\n/g, " / ");
    const right = source.slice(end, rightEnd).replace(/\n/g, " / ");
    const beforeToken = displayToken(source.slice(start, end), "(none)");
    const afterToken = displayToken(replacement, "(none)");
    const token = mode === "before" ? beforeToken : afterToken;
    const prefix = leftStart > 0 ? "... " : "";
    const suffix = rightEnd < source.length ? " ..." : "";
    return `${prefix}${left}[${token}]${right}${suffix}`;
  }
  function displayToken(text, emptyLabel) {
    if (text.length === 0) {
      return emptyLabel;
    }
    if (/^\s+$/.test(text)) {
      return `${text.length} space${text.length === 1 ? "" : "s"}`;
    }
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " / ");
  }
  function contextSnippet(issue) {
    const text = issue.originalText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const start = Math.max(0, issue.replacement.start - 40);
    const end = Math.min(text.length, issue.replacement.end + 40);
    const prefix = start > 0 ? "... " : "";
    const suffix = end < text.length ? " ..." : "";
    return `Context: ${prefix}${text.slice(start, end).replace(/\n/g, " / ")}${suffix}`;
  }
  function issueDisplayKey(issue) {
    return [issue.type, issue.message, changedText(issue), replacementText(issue)].join("");
  }
  function clearChildren(element) {
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }
  function getElement(document2, id) {
    const element = document2.getElementById(id);
    if (!element) {
      throw new Error(`Missing UI element #${id}`);
    }
    return element;
  }
  function labelForIssue(issue) {
    const labels = {
      spelling: "Spelling",
      grammar: "Grammar",
      punctuation: "Punctuation",
      glossary: "Glossary"
    };
    return labels[issue.type];
  }
  function sourceMode(result) {
    if (!result || result.targets.length === 0) {
      return "-";
    }
    const sources = new Set(result.targets.map((target) => target.source));
    if (sources.size > 1) {
      return "mixed";
    }
    if (sources.has("project-file")) {
      return "fallback";
    }
    return "native";
  }
  function languageLabel(language) {
    const labels = {
      auto: "Auto",
      de: "German",
      en: "English"
    };
    return labels[language];
  }
  function spellingModeLabel(mode) {
    if (mode === "openai_full") {
      return "OpenAI Transcript";
    }
    if (mode === "openai") {
      return "OpenAI Transcript";
    }
    return "OpenAI Transcript";
  }
  function defaultOpenAiSpellingSettings() {
    return {
      mode: "openai_full",
      apiKey: "",
      model: "gpt-4.1-mini"
    };
  }
  function parseOpenAiSpellingSettings(raw, fallback) {
    const parsed = JSON.parse(raw);
    return {
      mode: "openai_full",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : fallback.apiKey,
      model: typeof parsed.model === "string" && parsed.model.trim().length > 0 ? parsed.model : fallback.model
    };
  }
  function defaultGlossarySettings() {
    return {
      sharePointUrl: CENTRAL_GLOSSARY_SHAREPOINT_URL
    };
  }
  function parseGlossarySettings(raw) {
    const parsed = JSON.parse(raw);
    return {
      sharedPath: typeof parsed.sharedPath === "string" && parsed.sharedPath.trim().length > 0 ? parsed.sharedPath : void 0,
      sharePointUrl: typeof parsed.sharePointUrl === "string" && parsed.sharePointUrl.trim().length > 0 ? parsed.sharePointUrl : CENTRAL_GLOSSARY_SHAREPOINT_URL
    };
  }
  function dedupeIssues(issues) {
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const issue of issues) {
      const key = [
        projectIssueScope(issue),
        issue.replacement.start,
        issue.replacement.end,
        issue.replacement.replacement,
        issue.originalText
      ].join(":");
      if (!seen.has(key)) {
        seen.add(key);
        result.push(issue);
      }
    }
    return result;
  }
  function projectIssueScope(issue) {
    const projectFile = issue.target.projectFile;
    if (!projectFile) {
      return issue.targetId;
    }
    if (projectFile.kind === "project-file-offset") {
      return `xml:${projectFile.xmlOffset}`;
    }
    return `base64:${projectFile.base64XmlOffset}:${projectFile.decodedOriginal}`;
  }
  function serializeError(error) {
    if (error instanceof Error) {
      return { name: error.name, message: error.message, stack: error.stack ?? "" };
    }
    return { name: "Error", message: String(error) };
  }
  function isWritableIssue(issue) {
    if (issue.target.source === "transcript-api") {
      if (issue.ruleId === FULL_TRANSCRIPT_REWRITE_RULE_ID) {
        return true;
      }
      const corrected = applyReplacement(issue.originalText, issue.replacement);
      return transcriptTokenStructureCompatible(issue.originalText, corrected);
    }
    const target = issue.target.projectFile;
    if (target?.kind !== "project-file-base64-token") {
      return true;
    }
    return encodeUtf8(issue.suggestedText).byteLength === target.byteLength;
  }
  function nonWritableReason(issue) {
    if (issue.target.source === "transcript-api") {
      return "This item is review-only in this mode because the correction changes transcript token structure (word merge/split), which Premiere will reject for this import path.";
    }
    return "This item is review-only for now because Premiere stored it in a fixed-length binary caption payload.";
  }
  function transcriptTokenStructureCompatible(originalText, correctedText) {
    const originalTokens = tokenizeWords(originalText);
    const correctedTokens = tokenizeWords(correctedText);
    if (originalTokens.length === 0 || correctedTokens.length === 0) {
      return false;
    }
    if (originalTokens.length !== correctedTokens.length) {
      return false;
    }
    for (let index = 0; index < originalTokens.length; index += 1) {
      if (isPunctuationToken2(originalTokens[index]) !== isPunctuationToken2(correctedTokens[index])) {
        return false;
      }
    }
    return true;
  }
  function tokenizeWords(text) {
    const tokens = text.match(/[^\s]+/g);
    return tokens ? [...tokens] : [];
  }
  function isPunctuationToken2(token) {
    return /^[,.;:!?'"“”‘’()\-–—/…]+$/.test(token);
  }
  function createScanRunKey() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // src/main.ts
  var panel;
  function ensurePanel() {
    if (!panel) {
      panel = new SubtitleQAPanel(document);
    }
  }
  try {
    const { entrypoints } = __require("uxp");
    entrypoints.setup({
      panels: {
        subtitleQAPanel: {
          create() {
            ensurePanel();
          },
          show() {
            ensurePanel();
          }
        }
      }
    });
  } catch (error) {
    ensurePanel();
    console.warn("UXP entrypoints unavailable; running in development mode.", error);
  }
})();
//# sourceMappingURL=index.js.map
