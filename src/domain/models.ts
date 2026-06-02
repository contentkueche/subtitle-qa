export type IssueType = "spelling" | "grammar" | "punctuation" | "glossary";
export type IssueSeverity = "info" | "warning" | "error";
export type IssueStatus = "pending" | "accepted" | "rejected" | "applied";
export type TextSourceKind = "native-caption" | "graphic-text" | "project-file" | "transcript-api";
export type ScanLanguage = "auto" | "en" | "de";
export type ResolvedLanguage = "en" | "de";
export type SpellingEngineMode = "local" | "openai" | "openai_full";

export interface TextReplacement {
  start: number;
  end: number;
  replacement: string;
}

export interface XmlProjectFileTarget {
  kind: "project-file-offset";
  projectPath: string;
  xmlOffset: number;
  encodedOriginal: string;
  decodedOriginal: string;
  compression: "gzip" | "plain";
  nearbyXml: string;
}

export interface Base64ProjectFileTarget {
  kind: "project-file-base64-token";
  projectPath: string;
  xmlOffset: number;
  base64XmlOffset: number;
  base64EncodedOriginal: string;
  decodedOriginal: string;
  binaryOffset: number;
  byteLength: number;
  compression: "gzip" | "plain";
  nearbyXml: string;
}

export interface Base64StringProjectFileTarget {
  kind: "project-file-base64-string";
  projectPath: string;
  xmlOffset: number;
  base64XmlOffset: number;
  base64EncodedOriginal: string;
  decodedOriginal: string;
  binaryOffset: number;
  lengthOffset: number;
  byteLength: number;
  compression: "gzip" | "plain";
  nearbyXml: string;
}

export type ProjectFileTarget = XmlProjectFileTarget | Base64ProjectFileTarget | Base64StringProjectFileTarget;

export interface NativeTextTarget {
  kind: "component-param" | "caption-method" | "transcript-segment";
  trackItem?: any;
  component?: any;
  param?: any;
  startTime?: any;
  accessor?: string;
  mutator?: string;
  transcriptSegmentIndex?: number;
}

export interface TextTarget {
  id: string;
  source: TextSourceKind;
  label: string;
  sequenceName?: string;
  trackType?: "caption" | "video";
  trackIndex?: number;
  itemIndex?: number;
  componentIndex?: number;
  paramIndex?: number;
  startTicks?: string;
  endTicks?: string;
  originalText: string;
  confidence: "high" | "medium" | "low";
  native?: NativeTextTarget;
  projectFile?: ProjectFileTarget;
}

export interface Issue {
  id: string;
  targetId: string;
  type: IssueType;
  severity: IssueSeverity;
  ruleId: string;
  message: string;
  originalText: string;
  suggestedText: string;
  replacement: TextReplacement;
  status: IssueStatus;
  target: TextTarget;
}

export interface GlossaryTerm {
  term: string;
  preferred: string;
  language?: ResolvedLanguage;
  caseSensitive?: boolean;
  note?: string;
}

export interface Glossary {
  brandTerms: GlossaryTerm[];
}

export interface OpenAiSpellingSettings {
  mode: SpellingEngineMode;
  apiKey: string;
  model: string;
}

export interface CapabilityReport {
  activeProject: boolean;
  activeSequence: boolean;
  captionTracks: "available" | "unavailable" | "unknown";
  captionTextRead: "available" | "unavailable" | "unknown";
  captionTextWrite: "available" | "unavailable" | "unknown";
  graphicTextRead: "available" | "unavailable" | "unknown";
  graphicTextWrite: "available" | "unavailable" | "unknown";
  projectFileFallback: "available" | "unavailable" | "not-needed" | "unknown";
  notes: string[];
}

export interface ScanResult {
  projectName?: string;
  projectPath?: string;
  sequenceName?: string;
  capability: CapabilityReport;
  targets: TextTarget[];
  issues: Issue[];
}

export interface ApplyResult {
  appliedCount: number;
  backupPath?: string;
  mode: "official-api" | "project-file-fallback" | "none";
  message: string;
}
