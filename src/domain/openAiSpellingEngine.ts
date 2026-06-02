import type { Glossary, Issue, OpenAiSpellingSettings, ScanLanguage, TextTarget } from "./models";
import { applyReplacement, computeReplacementsFromTexts, makeIssueId } from "./textEdits";

interface OpenAiSpellingResponse {
  corrections: Array<{
    id: string;
    corrected: string;
  }>;
}

export class OpenAiSpellingEngine {
  constructor(
    private readonly endpoint = "https://api.openai.com/v1/responses",
    private readonly timeoutMs = 20000
  ) {}

  async checkTargets(targets: TextTarget[], language: ScanLanguage, settings: OpenAiSpellingSettings): Promise<Issue[]> {
    return this.checkTargetsWithGlossary(targets, language, settings, { brandTerms: [] });
  }

  async checkTargetsWithGlossary(
    targets: TextTarget[],
    language: ScanLanguage,
    settings: OpenAiSpellingSettings,
    glossary: Glossary
  ): Promise<Issue[]> {
    if (settings.mode === "local") {
      return [];
    }

    const apiKey = settings.apiKey.trim();
    if (!apiKey) {
      throw new Error("OpenAI mode is enabled, but no API key is configured.");
    }

    const model = settings.model.trim() || "gpt-4.1-mini";
    const isFullQaMode = settings.mode === "openai_full";
    const payload = buildRequestPayload(targets, language, model, isFullQaMode ? "full" : "spelling", glossary);
    const responseJson = await this.postJson(payload, apiKey);
    const parsed = parseSpellingResponse(responseJson);
    const mapped = new Map(parsed.corrections.map((item) => [item.id, item.corrected]));

    const issues: Issue[] = [];
    for (const target of targets) {
      const corrected = mapped.get(target.id);
      if (!corrected || corrected === target.originalText) {
        continue;
      }

      const replacements = computeReplacementsFromTexts(target.originalText, corrected).filter((replacement) =>
        isFullQaMode ? isFullQaReplacement(target.originalText, replacement) : isOrthographyReplacement(target.originalText, replacement)
      );
      if (replacements.length === 0) {
        continue;
      }

      const correctedFromAllowed = replacements
        .slice()
        .sort((a, b) => b.start - a.start || b.end - a.end)
        .reduce((text, replacement) => applyReplacement(text, replacement), target.originalText);

      for (const replacement of replacements) {
        const issueType = isFullQaMode
          ? classifyFullQaIssueType(target.originalText.slice(replacement.start, replacement.end), replacement.replacement)
          : "spelling";
        const message = isFullQaMode ? messageForFullQaIssueType(issueType) : "Spelling suggestion from OpenAI.";
        issues.push({
          id: makeIssueId(target.id, "openai-spelling", replacement.start, replacement.end),
          targetId: target.id,
          type: issueType,
          severity: "warning",
          ruleId: isFullQaMode ? "openai-full-qa" : "openai-spelling",
          message,
          originalText: target.originalText,
          suggestedText: correctedFromAllowed,
          replacement,
          status: "pending",
          target
        });
      }
    }

    return issues;
  }

  private async postJson(payload: unknown, apiKey: string): Promise<any> {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timeout = controller
      ? setTimeout(() => {
          controller.abort();
        }, this.timeoutMs)
      : undefined;

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
          // ignore response parse errors
        }
        throw new Error(`OpenAI request failed with HTTP ${response.status}.${detail}`);
      }

      return await response.json();
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

type OpenAiRequestMode = "spelling" | "full";

function buildRequestPayload(
  targets: TextTarget[],
  language: ScanLanguage,
  model: string,
  mode: OpenAiRequestMode,
  glossary: Glossary
): Record<string, unknown> {
  const languageMode =
    language === "de" ? "German" : language === "en" ? "English" : "Auto-detect per subtitle line (German or English)";
  const glossaryTerms = glossary.brandTerms
    .slice(0, 300)
    .map((term) => ({
      term: term.term,
      preferred: term.preferred,
      language: term.language ?? "both",
      caseSensitive: term.caseSensitive ?? false,
      note: term.note ?? ""
    }));

  const userPayload = {
    languageMode,
    glossaryTerms,
    targets: targets.map((target, index) => ({
      id: target.id,
      text: target.originalText,
      languageHint: detectLanguageHint(target.originalText),
      previousLine: index > 0 ? targets[index - 1].originalText : "",
      nextLine: index + 1 < targets.length ? targets[index + 1].originalText : ""
    }))
  };

  return {
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "You are a subtitle orthography checker for Adobe Premiere captions.",
              ...(mode === "spelling"
                ? [
                    "Return corrections for spelling and obvious written-form errors.",
                    "Use sentence meaning and nearby subtitle context to decide whether a word is misspelled.",
                    "You may fix real-word spelling confusion when context clearly indicates a typo.",
                    "Fix capitalization when required by language orthography.",
                    "For German lines, correct noun capitalization when clearly identifiable from context.",
                    "Actively validate names in location/company contexts (for example after 'in', 'bei', 'aus', or in phrases like 'bei der Firma ...').",
                    "Correct clear proper-name/place-name misspellings when confidence is high (example: Gautingen -> Gauting).",
                    "When a company, product, person, or location appears in glossaryTerms, use the preferred form exactly.",
                    "For likely company names spanning multiple words, normalize obvious spacing or hyphenation issues when confidence is high (example: Roth Kegel -> Roth-Kegel).",
                    "Fix obvious repeated-letter typos (example: Checkk -> Check).",
                    "If a proper name is uncertain, keep it unchanged.",
                    "You may fix obvious casing and apostrophes needed for correct written form.",
                    "You may fix very short colloquial misspellings when context is clear (example: German 'net' -> 'nicht').",
                    "Do not insert or move punctuation unless needed to preserve the corrected word form itself."
                  ]
                : [
                    "Return corrections for spelling, grammar, punctuation, spacing, and obvious typo-related word choice errors.",
                    "Use sentence meaning and nearby subtitle context. Fix obvious errors even inside long transcript blocks.",
                    "Actively validate names in location/company contexts (for example after 'in', 'bei', 'aus', or in phrases like 'bei der Firma ...').",
                    "When a company, product, person, or location appears in glossaryTerms, use the preferred form exactly.",
                    "For likely company names spanning multiple words, normalize obvious spacing or hyphenation issues when confidence is high (example: Roth Kegel -> Roth-Kegel).",
                    "Preserve tone and meaning; keep subtitle-friendly brevity.",
                    "For German, apply correct noun capitalization and natural punctuation/spacing.",
                    "For mixed German/English text, keep words in their source language and only correct the faulty parts.",
                    "Fix obvious malformed constructions like missing spaces after commas and unnecessary inline dashes.",
                    "If text has clear mistakes, do not return it unchanged.",
                    "Examples of expected fixes: 'Dont' -> 'Don't', 'the premier pro test' -> 'the Premiere Pro test', 'bestimt' -> 'bestimmt'.",
                    "If a phrase is ambiguous, prefer minimal safe edits."
                  ]),
              "Do not rewrite style or change the meaning.",
              "Do not paraphrase or reorder text.",
              "Return every target id once. If no fix is needed, return the original text unchanged."
            ].join(" ")
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(userPayload)
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "subtitle_spelling_response",
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
                  corrected: { type: "string" }
                },
                required: ["id", "corrected"]
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

function parseSpellingResponse(raw: any): OpenAiSpellingResponse {
  const direct = raw?.output_text;
  if (typeof direct === "string" && direct.trim()) {
    return validateSpellingResponse(JSON.parse(direct));
  }

  if (Array.isArray(direct)) {
    const joined = direct.filter((part) => typeof part === "string").join("");
    if (joined.trim()) {
      return validateSpellingResponse(JSON.parse(joined));
    }
  }

  const output = Array.isArray(raw?.output) ? raw.output : [];
  const textParts: string[] = [];
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
    return validateSpellingResponse(JSON.parse(combined));
  }

  throw new Error("OpenAI response did not contain parsable JSON spelling output.");
}

function validateSpellingResponse(value: unknown): OpenAiSpellingResponse {
  if (!value || typeof value !== "object") {
    throw new Error("OpenAI response JSON is not an object.");
  }

  const corrections = (value as { corrections?: unknown }).corrections;
  if (!Array.isArray(corrections)) {
    throw new Error("OpenAI response JSON is missing corrections[].");
  }

  return {
    corrections: corrections.map((entry, index) => {
      const item = entry as { id?: unknown; corrected?: unknown };
      if (typeof item?.id !== "string" || typeof item?.corrected !== "string") {
        throw new Error(`OpenAI correction at index ${index} is invalid.`);
      }
      return { id: item.id, corrected: item.corrected };
    })
  };
}

function isOrthographyReplacement(
  originalText: string,
  replacement: { start: number; end: number; replacement: string }
): boolean {
  const originalSegment = originalText.slice(replacement.start, replacement.end);
  if (isCaseOnlyChange(originalSegment, replacement.replacement)) {
    return false;
  }
  if (replacement.replacement.includes("  ")) {
    return false;
  }
  const allowedChars = /^[\p{L}\p{M}\p{N}'’\- ]*$/u;
  if (!allowedChars.test(originalSegment) || !allowedChars.test(replacement.replacement)) {
    return false;
  }
  return true;
}

function isFullQaReplacement(originalText: string, replacement: { start: number; end: number; replacement: string }): boolean {
  const originalSegment = originalText.slice(replacement.start, replacement.end);
  if (replacement.replacement.length > Math.max(32, originalSegment.length + 20)) {
    return false;
  }
  return true;
}

function isCaseOnlyChange(original: string, replacement: string): boolean {
  if (original === replacement) {
    return false;
  }
  return original.toLocaleLowerCase("de-DE") === replacement.toLocaleLowerCase("de-DE");
}

function detectLanguageHint(text: string): "de" | "en" | "mixed" {
  const sample = text.toLowerCase();
  let germanScore = 0;
  let englishScore = 0;

  if (/[äöüß]/i.test(sample)) {
    germanScore += 3;
  }
  if (/\b(der|die|das|und|nicht|mit|ist|sind|wir|ihr|für|auch|aber)\b/.test(sample)) {
    germanScore += 2;
  }
  if (/\b(the|and|not|with|is|are|we|you|for|also|this|that|but)\b/.test(sample)) {
    englishScore += 2;
  }

  if (germanScore >= 2 && englishScore >= 2) {
    return "mixed";
  }

  return germanScore >= englishScore ? "de" : "en";
}

function classifyFullQaIssueType(originalSegment: string, replacement: string): Issue["type"] {
  if (originalSegment === replacement) {
    return "spelling";
  }

  const punctuationOrSpacing = /[\s.,;:!?'"-]/;
  if (
    punctuationOrSpacing.test(originalSegment) ||
    punctuationOrSpacing.test(replacement) ||
    originalSegment.trim().length === 0 ||
    replacement.trim().length === 0
  ) {
    return "punctuation";
  }

  return "grammar";
}

function messageForFullQaIssueType(type: Issue["type"]): string {
  if (type === "punctuation") {
    return "Sentence QA suggestion from OpenAI (punctuation/spacing).";
  }
  if (type === "grammar") {
    return "Sentence QA suggestion from OpenAI (grammar/wording).";
  }
  return "Sentence QA suggestion from OpenAI.";
}
