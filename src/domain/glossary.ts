import type { Glossary } from "./models";

export const defaultGlossary: Glossary = {
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

export function parseGlossaryJson(raw: string): Glossary {
  const parsed = JSON.parse(raw) as Partial<Glossary>;
  if (!Array.isArray(parsed.brandTerms)) {
    throw new Error("Glossary JSON must contain a brandTerms array.");
  }

  return {
    brandTerms: parsed.brandTerms.map((entry, index) => {
      if (!entry || typeof entry.term !== "string" || typeof entry.preferred !== "string") {
        throw new Error(`Glossary entry ${index + 1} must include term and preferred strings.`);
      }
      if (entry.language !== undefined && entry.language !== "de" && entry.language !== "en") {
        throw new Error(`Glossary entry ${index + 1} language must be "de" or "en" when provided.`);
      }

      return {
        term: entry.term,
        preferred: entry.preferred,
        language: entry.language,
        caseSensitive: Boolean(entry.caseSensitive),
        note: typeof entry.note === "string" ? entry.note : undefined
      };
    })
  };
}
