import type { Issue, TextTarget } from "../domain/models";
import { Logger } from "../domain/logger";
import { FULL_TRANSCRIPT_REWRITE_RULE_ID } from "../domain/openAiTranscriptCleanupEngine";
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
  correctedText: string;
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

  async apply(context: PremiereContext, issues: Issue[]): Promise<number> {
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

      const updatedWords = fullRewriteIssue
        ? rewriteWordsWithTiming(segment.words, correctedText)
        : applyCorrectionToWords(segment.words, correctedText);
      if (!updatedWords) {
        this.logger.warn(
          fullRewriteIssue
            ? "Skipping transcript segment because a timed full rewrite could not be generated."
            : "Skipping transcript segment because correction is not token-stable for the official Transcript API.",
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
      const mismatches = await this.verifyImportedTranscript(context, updatePlans);
      if (mismatches.length > 0) {
        this.logger.error("Transcript import verification failed; restoring previous transcript JSON.", { mismatches });
        tryImportTranscript(context, originalTranscript, clipProjectItems, this.logger);
        throw new Error(`Transcript import verification failed for segment(s): ${mismatches.join(", ")}. Previous transcript was restored.`);
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
    const appliedPlans: SegmentUpdatePlan[] = [];
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

  detectCaptionGenerationApis(context: PremiereContext): string[] {
    const candidates = [
      ...methodNames(context.ppro?.Transcript).map((name) => `ppro.Transcript.${name}`),
      ...methodNames(context.ppro?.CaptionTrack).map((name) => `ppro.CaptionTrack.${name}`),
      ...methodNames(context.ppro?.Caption).map((name) => `ppro.Caption.${name}`),
      ...methodNames(context.sequence).map((name) => `sequence.${name}`)
    ];

    return candidates
      .filter((name) => /(caption|subtitle)/i.test(name) && /(create|generate|import|add|insert)/i.test(name))
      .sort();
  }

  private async verifyImportedTranscript(context: PremiereContext, plans: SegmentUpdatePlan[]): Promise<number[]> {
    const payload = await this.exportTranscriptJson(context);
    if (!payload) {
      return plans.map((plan) => plan.segmentIndex);
    }

    const imported = parseTranscriptJson(payload);
    const segments = imported.segments ?? [];
    const mismatches: number[] = [];
    for (const plan of plans) {
      const words = segments[plan.segmentIndex]?.words;
      const text = Array.isArray(words) ? composeTranscriptText(words) : "";
      if (!sameTranscriptText(text, plan.correctedText)) {
        mismatches.push(plan.segmentIndex);
      }
    }

    return mismatches;
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

function applyCorrectionToWords(originalWords: TranscriptWord[], correctedText: string): TranscriptWord[] | undefined {
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

  return undefined;
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

function rewriteWordsWithTiming(originalWords: TranscriptWord[], correctedText: string): TranscriptWord[] | undefined {
  const tokens = tokenizeTranscriptText(correctedText);
  if (tokens.length === 0) {
    return undefined;
  }

  const timedWords = originalWords.filter((word) => {
    const token = typeof word.text === "string" ? word.text.trim() : "";
    return token.length > 0 && typeof word.start === "number" && typeof word.duration === "number";
  });
  if (timedWords.length === 0) {
    return undefined;
  }

  const firstStart = timedWords[0].start;
  const lastEnd = timedWords.reduce((max, word) => Math.max(max, (word.start ?? 0) + Math.max(0, word.duration ?? 0)), firstStart ?? 0);
  if (typeof firstStart !== "number" || !Number.isFinite(firstStart) || !Number.isFinite(lastEnd) || lastEnd <= firstStart) {
    return undefined;
  }

  const totalDuration = lastEnd - firstStart;
  const weights = tokens.map(tokenTimingWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return undefined;
  }

  const confidence = averageConfidence(timedWords);
  let cursor = firstStart;
  let consumedWeight = 0;
  return tokens.map((token, index) => {
    consumedWeight += weights[index];
    const nextCursor = index === tokens.length - 1 ? lastEnd : firstStart + (totalDuration * consumedWeight) / totalWeight;
    const duration = Math.max(0, nextCursor - cursor);
    const word: TranscriptWord = {
      confidence,
      duration,
      eos: index === tokens.length - 1,
      start: cursor,
      text: token,
      type: isPunctuationToken(token) ? "punctuation" : "word"
    };
    cursor = nextCursor;
    return word;
  });
}

function tokenTimingWeight(token: string): number {
  const letters = token.replace(/[^\p{L}\p{M}\p{N}]/gu, "").length;
  return Math.max(1, letters);
}

function averageConfidence(words: TranscriptWord[]): number {
  const values = words.map((word) => word.confidence).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) {
    return 1;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hasUsableTiming(words: TranscriptWord[]): boolean {
  return words.length > 0 && words.every((word) => typeof word.start === "number" && typeof word.duration === "number");
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

function methodNames(value: any): string[] {
  if (!value) {
    return [];
  }

  const names = new Set<string>();
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

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function sameTranscriptText(left: string, right: string): boolean {
  return normalizeTranscriptText(left) === normalizeTranscriptText(right);
}

function normalizeTranscriptText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}
