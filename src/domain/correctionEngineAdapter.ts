import type { Glossary, Issue, ScanLanguage, TextTarget } from "./models";

export interface CorrectionEngine {
  checkTargets(targets: TextTarget[], glossary: Glossary, language: ScanLanguage): Issue[] | Promise<Issue[]>;
}

export interface RemoteCorrectionRequest {
  language: ScanLanguage;
  targets: Array<{
    id: string;
    label: string;
    source: TextTarget["source"];
    text: string;
  }>;
  glossary: Glossary;
}

export interface RemoteCorrectionResponse {
  issues: Issue[];
}

export class RemoteCorrectionEngineAdapter implements CorrectionEngine {
  constructor(
    private readonly endpoint: string,
    private readonly getAuthHeaders: () => Record<string, string> = () => ({})
  ) {}

  async checkTargets(targets: TextTarget[], glossary: Glossary, language: ScanLanguage): Promise<Issue[]> {
    const request: RemoteCorrectionRequest = {
      language,
      targets: targets.map((target) => ({
        id: target.id,
        label: target.label,
        source: target.source,
        text: target.originalText
      })),
      glossary
    };

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.getAuthHeaders()
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`Correction engine returned HTTP ${response.status}.`);
    }

    const parsed = (await response.json()) as RemoteCorrectionResponse;
    return parsed.issues;
  }
}
