import type { Issue, TextTarget } from "../domain/models";
import { Logger } from "../domain/logger";
import { applyIssueSet } from "../domain/textEdits";
import type { PremiereContext } from "./premiereContext";
import { looksLikeHumanText } from "./nativeScanner";

interface TranscriptWord {
  confidence?: number;
  duration?: number;
  eos?: boolean;
  start?: number;
  tags?: unknown[];
  text?: string;
  type?: string;
}

interface TranscriptSegment {
  words?: TranscriptWord[];
}

interface TranscriptJson {
  segments?: TranscriptSegment[];
}

interface SegmentUpdatePlan {
  issueCount: number;
  segmentIndex: number;
  updatedWords: TranscriptWord[];
}

interface TranscriptImportAttemptResult {
  errorMessage: string;
  success: boolean;
}

interface TranscriptImportActionResult {
  action?: any;
  errorMessage: string;
}

interface ApplyTranscriptOptions {
  allowStructureChanges?: boolean;
}

export class TranscriptApiBridge {
  constructor(private readonly logger: Logger) {}

  async scan(context: PremiereContext): Promise<TextTarget[]> {
    const payload = await this.exportTranscriptJson(context);
    if (!payload) {
      return [];
    }

    const transcript = parseTranscriptJson(payload);
    const segments = transcript.segments ?? [];
    const targets: TextTarget[] = [];

    for (let index = 0; index < segments.length; index += 1) {
      const words = Array.isArray(segments[index]?.words) ? segments[index]?.words ?? [] : [];
      const text = composeTranscriptText(words);
      if (!looksLikeHumanText(text)) {
        continue;
      }
      targets.push({
        id: `transcript-api:${index}:${hashString(text)}`,
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

  async apply(context: PremiereContext, issues: Issue[], options: ApplyTranscriptOptions = {}): Promise<number> {
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
    const updatePlans: SegmentUpdatePlan[] = [];

    for (const [segmentIndex, segmentIssues] of groups) {
      const segment = segments[segmentIndex];
      if (!segment || !Array.isArray(segment.words)) {
        this.logger.warn("Transcript segment missing at apply time; skipping.", { segmentIndex });
        continue;
      }

      const originalText = composeTranscriptText(segment.words);
      const correctedText = applyIssueSet(originalText, segmentIssues);
      if (correctedText === originalText) {
        continue;
      }

      if (!looksLikeHumanText(correctedText)) {
        this.logger.warn("Refusing unsafe transcript correction.", { segmentIndex });
        continue;
      }

      const updatedWords = applyCorrectionToWords(segment.words, correctedText, options.allowStructureChanges === true);
      if (!updatedWords) {
        this.logger.warn("Skipping transcript segment because correction would change token structure.", {
          segmentIndex,
          originalPreview: originalText.slice(0, 140),
          correctedPreview: correctedText.slice(0, 140)
        });
        continue;
      }

      updatePlans.push({
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
    const failedSegments: number[] = [];

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
    }

    if (appliedSegmentCount === 0) {
      throw new Error(fullAttempt.errorMessage);
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

  private async exportTranscriptJson(context: PremiereContext): Promise<string | undefined> {
    const ppro = context.ppro;
    if (typeof ppro?.Transcript?.exportToJSON !== "function") {
      return undefined;
    }

    const clipProjectItems = await getTranscriptImportCandidates(context);
    const clipProjectItem = clipProjectItems[0];
    if (!clipProjectItem) {
      return undefined;
    }

    const exported = await ppro.Transcript.exportToJSON(clipProjectItem);
    if (typeof exported !== "string" || !exported.trim()) {
      return undefined;
    }
    return exported;
  }
}

async function getTranscriptImportCandidates(context: PremiereContext): Promise<any[]> {
  const items: any[] = [];
  items.push(...(await getSequenceProjectItemCandidates(context)));
  items.push(...(await getSelectedProjectItemCandidates(context)));
  items.push(...(await getRootClipProjectItemCandidates(context)));
  return dedupeObjects(items);
}

async function getSequenceProjectItemCandidates(context: PremiereContext): Promise<any[]> {
  const sequence = context.sequence;
  if (!sequence || typeof sequence.getProjectItem !== "function") {
    return [];
  }

  const projectItem = await sequence.getProjectItem();
  if (!projectItem) {
    return [];
  }

  const items: any[] = [projectItem];
  const cast = context.ppro?.ClipProjectItem?.cast;
  if (typeof cast === "function") {
    try {
      const castItem = cast(projectItem);
      if (castItem) {
        items.unshift(castItem);
      }
    } catch {
      // ignore cast errors and fall back to raw project item
    }
  }

  return items;
}

async function getSelectedProjectItemCandidates(context: PremiereContext): Promise<any[]> {
  const projectUtils = context.ppro?.ProjectUtils;
  if (!projectUtils || typeof projectUtils.getSelection !== "function") {
    return [];
  }

  const selection = await projectUtils.getSelection(context.project);
  if (!selection) {
    return [];
  }

  const selectedItems = await normalizeSelectionItems(selection);
  const candidates: any[] = [];
  for (const item of selectedItems) {
    candidates.push(...toClipProjectItemCandidates(item, context.ppro));
  }
  return candidates;
}

async function getRootClipProjectItemCandidates(context: PremiereContext): Promise<any[]> {
  const projectUtils = context.ppro?.ProjectUtils;
  if (!projectUtils || typeof projectUtils.getRootItem !== "function") {
    return [];
  }

  const root = await projectUtils.getRootItem(context.project);
  if (!root || typeof root.getItems !== "function") {
    return [];
  }

  const queue: any[] = await root.getItems();
  const candidates: any[] = [];
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

async function normalizeSelectionItems(selection: any): Promise<any[]> {
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

function toClipProjectItemCandidates(item: any, ppro: any): any[] {
  const candidates: any[] = [];
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
      // ignore cast errors and keep raw candidate
    }
  }

  return candidates;
}

function parseTranscriptJson(raw: string): TranscriptJson {
  const parsed = JSON.parse(raw) as TranscriptJson;
  if (!parsed || !Array.isArray(parsed.segments)) {
    throw new Error("Transcript JSON did not contain segments[].");
  }
  return parsed;
}

function composeTranscriptText(words: TranscriptWord[]): string {
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

function tokenizeTranscriptText(text: string): string[] {
  const tokens = text.match(/[^\s]+/g);
  return tokens ? [...tokens] : [];
}

function applyCorrectionToWords(
  originalWords: TranscriptWord[],
  correctedText: string,
  allowStructureChanges: boolean
): TranscriptWord[] | undefined {
  const textWordIndices: number[] = [];
  const originalTokens: string[] = [];
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
    return undefined;
  }

  if (tokens.length === originalTokens.length) {
    return applyTokenStableCorrection(originalWords, textWordIndices, tokens);
  }

  if (!allowStructureChanges) {
    return undefined;
  }

  return applyStructureChangeCorrection(originalWords, textWordIndices, tokens);
}

function applyTokenStableCorrection(
  originalWords: TranscriptWord[],
  textWordIndices: number[],
  tokens: string[]
): TranscriptWord[] | undefined {
  const nextWords = cloneWords(originalWords);
  for (let slot = 0; slot < textWordIndices.length; slot += 1) {
    const wordIndex = textWordIndices[slot];
    const originalToken = typeof originalWords[wordIndex]?.text === "string" ? originalWords[wordIndex]?.text ?? "" : "";
    const token = tokens[slot] ?? "";
    const originalIsPunctuation = isPunctuationToken(originalToken);
    const replacementIsPunctuation = isPunctuationToken(token);
    if (originalIsPunctuation !== replacementIsPunctuation) {
      return undefined;
    }
    nextWords[wordIndex] = { ...nextWords[wordIndex], text: token };
  }
  return nextWords;
}

function applyStructureChangeCorrection(
  originalWords: TranscriptWord[],
  textWordIndices: number[],
  correctedTokens: string[]
): TranscriptWord[] | undefined {
  if (textWordIndices.length === 0) {
    return undefined;
  }

  const mappedTokens = mapTokensToFixedWordSlots(correctedTokens, textWordIndices.length);
  if (mappedTokens.length !== textWordIndices.length) {
    return undefined;
  }

  const nextWords = cloneWords(originalWords);
  for (let slot = 0; slot < textWordIndices.length; slot += 1) {
    const wordIndex = textWordIndices[slot];
    const mapped = mappedTokens[slot] ?? "";
    const current = nextWords[wordIndex] ?? {};
    const nextWord: TranscriptWord = { ...current, text: mapped };
    if (mapped) {
      nextWord.type = isPunctuationToken(mapped) ? "punctuation" : "word";
    }
    nextWord.eos = false;
    nextWords[wordIndex] = nextWord;
  }

  const eosIndex = findLastNonEmptyMappedSlot(mappedTokens);
  if (eosIndex >= 0) {
    const wordIndex = textWordIndices[eosIndex];
    nextWords[wordIndex] = { ...nextWords[wordIndex], eos: true };
  }

  return nextWords;
}

function mapTokensToFixedWordSlots(tokens: string[], slots: number): string[] {
  if (slots <= 0 || tokens.length === 0) {
    return [];
  }

  if (tokens.length === slots) {
    return [...tokens];
  }

  if (tokens.length < slots) {
    const padded = [...tokens];
    while (padded.length < slots) {
      padded.push("");
    }
    return padded;
  }

  const mapped = new Array<string>(slots).fill("");
  for (let index = 0; index < slots - 1; index += 1) {
    mapped[index] = tokens[index] ?? "";
  }
  mapped[slots - 1] = tokens.slice(slots - 1).join(" ").trim();
  return mapped;
}

function findLastNonEmptyMappedSlot(mappedTokens: string[]): number {
  for (let index = mappedTokens.length - 1; index >= 0; index -= 1) {
    if ((mappedTokens[index] ?? "").trim().length > 0) {
      return index;
    }
  }
  return -1;
}

function groupBySegment(issues: Issue[]): Map<number, Issue[]> {
  const groups = new Map<number, Issue[]>();
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

function createTranscriptImportAction(ppro: any, textSegments: any, candidates: any[], logger: Logger): TranscriptImportActionResult {
  const errors: Array<{ index: number; message: string }> = [];

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

function tryImportTranscript(
  context: PremiereContext,
  transcript: TranscriptJson,
  candidates: any[],
  logger: Logger,
  segmentIndex?: number
): TranscriptImportAttemptResult {
  const importAttempt = (): TranscriptImportAttemptResult => {
    try {
      const textSegments = context.ppro.Transcript.importFromJSON(JSON.stringify(transcript));
      const actionResult = createTranscriptImportAction(context.ppro, textSegments, candidates, logger);
      if (!actionResult.action) {
        return { success: false, errorMessage: actionResult.errorMessage };
      }

      const success = context.project.executeTransaction((compoundAction: any) => {
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
    let result: TranscriptImportAttemptResult | undefined;
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

function applyPlansToTranscript(transcript: TranscriptJson, plans: SegmentUpdatePlan[]): boolean {
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

function cloneTranscript(transcript: TranscriptJson): TranscriptJson {
  const segments = Array.isArray(transcript.segments)
    ? transcript.segments.map((segment) => ({
        ...segment,
        words: Array.isArray(segment.words) ? cloneWords(segment.words) : segment.words
      }))
    : transcript.segments;
  return { ...transcript, segments };
}

function cloneWords(words: TranscriptWord[]): TranscriptWord[] {
  return words.map((word) => ({ ...word }));
}

function isPunctuationToken(token: string): boolean {
  return /^[,.;:!?'"“”‘’()\-–—/…]+$/.test(token);
}

function dedupeObjects<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const next: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      next.push(value);
    }
  }
  return next;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
