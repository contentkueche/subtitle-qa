import type { Glossary, Issue, OpenAiSpellingSettings, ScanLanguage, TextTarget } from "./models";
import { makeIssueId } from "./textEdits";

interface OpenAiTranscriptCleanupResponse {
  corrections: Array<{
    id: string;
    corrected: string;
    note: string;
  }>;
}

export const FULL_TRANSCRIPT_REWRITE_RULE_ID = "openai-transcript-rewrite";

export class OpenAiTranscriptCleanupEngine {
  constructor(
    private readonly endpoint = "https://api.openai.com/v1/responses",
    private readonly timeoutMs = 30000
  ) {}

  async cleanTargets(
    targets: TextTarget[],
    language: ScanLanguage,
    settings: OpenAiSpellingSettings,
    glossary: Glossary
  ): Promise<Issue[]> {
    const apiKey = settings.apiKey.trim();
    if (!apiKey) {
      throw new Error("Clean Transcript needs an OpenAI API key in Engine Settings.");
    }

    const model = settings.model.trim() || "gpt-4.1-mini";
    const responseJson = await this.postJson(buildRequestPayload(targets, language, model, glossary), apiKey);
    const parsed = parseCleanupResponse(responseJson);
    const mapped = new Map(parsed.corrections.map((item) => [item.id, item]));
    const issues: Issue[] = [];

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
        throw new Error(`OpenAI transcript cleanup failed with HTTP ${response.status}.${detail}`);
      }

      return await response.json();
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

function buildRequestPayload(
  targets: TextTarget[],
  language: ScanLanguage,
  model: string,
  glossary: Glossary
): Record<string, unknown> {
  const languageMode =
    language === "de" ? "German" : language === "en" ? "English" : "Auto-detect per transcript segment (German or English)";
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

function parseCleanupResponse(raw: any): OpenAiTranscriptCleanupResponse {
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
    return validateCleanupResponse(JSON.parse(combined));
  }

  throw new Error("OpenAI response did not contain parsable JSON transcript cleanup output.");
}

function validateCleanupResponse(value: unknown): OpenAiTranscriptCleanupResponse {
  if (!value || typeof value !== "object") {
    throw new Error("OpenAI transcript cleanup JSON is not an object.");
  }

  const corrections = (value as { corrections?: unknown }).corrections;
  if (!Array.isArray(corrections)) {
    throw new Error("OpenAI transcript cleanup JSON is missing corrections[].");
  }

  return {
    corrections: corrections.map((entry, index) => {
      const item = entry as { id?: unknown; corrected?: unknown; note?: unknown };
      if (typeof item?.id !== "string" || typeof item?.corrected !== "string" || typeof item?.note !== "string") {
        throw new Error(`OpenAI transcript correction at index ${index} is invalid.`);
      }
      return { id: item.id, corrected: item.corrected, note: item.note };
    })
  };
}

function normalizeReturnedTranscript(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isSafeTranscriptRewrite(original: string, corrected: string): boolean {
  if (corrected.length < 2 || corrected.length > Math.max(120, original.length * 2.2)) {
    return false;
  }
  if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(corrected)) {
    return false;
  }
  return true;
}
