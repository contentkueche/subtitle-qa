import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";
import type { Issue, ProjectFileTarget, TextTarget } from "../domain/models";
import { Logger } from "../domain/logger";
import { applyIssueSet } from "../domain/textEdits";
import { UxpFileSystem } from "../platform/fileSystem";
import { decodeUtf8, encodeUtf8 } from "../platform/utf8";
import { looksLikeHumanText } from "./nativeScanner";

interface ProjectXml {
  xml: string;
  compression: "gzip" | "plain";
}

interface Base64ScanResult {
  captionCandidates: ProjectFileTarget[];
  transcriptCandidates: ProjectFileTarget[];
  formattedTextPayloads: number;
  transcriptOnlyCandidates: number;
  stylePayloads: number;
  otherBase64Payloads: number;
}

interface Base64ScanOptions {
  includeCaptionBlocks: boolean;
  includeTranscriptBlocks: boolean;
}

export class ProjectFileFallback {
  constructor(
    private readonly fs: UxpFileSystem,
    private readonly logger: Logger
  ) {}

  async scan(projectPath: string, sequenceName?: string): Promise<TextTarget[]> {
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

  async scanTranscript(projectPath: string, sequenceName?: string): Promise<TextTarget[]> {
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

  async apply(projectPath: string, acceptedIssues: Issue[]): Promise<void> {
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

  private async readProjectXml(projectPath: string): Promise<ProjectXml> {
    const bytes = await this.fs.readFileBytes(projectPath);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const inflated = gunzipSync(bytes);
      return { xml: decodeUtf8(inflated), compression: "gzip" };
    }

    const xml = decodeUtf8(bytes);
    if (!xml.trimStart().startsWith("<")) {
      throw new Error("Project file is neither gzip-compressed XML nor plain XML.");
    }
    return { xml, compression: "plain" };
  }
}

function extractTextCandidates(xml: string, projectPath: string, compression: "gzip" | "plain"): ProjectFileTarget[] {
  const candidates: ProjectFileTarget[] = [];
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

function extractBase64TextCandidates(
  xml: string,
  projectPath: string,
  compression: "gzip" | "plain",
  options: Base64ScanOptions
): Base64ScanResult {
  const captionCandidates: ProjectFileTarget[] = [];
  const transcriptCandidates: ProjectFileTarget[] = [];
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

function refreshProjectTarget(
  xml: string,
  projectPath: string,
  compression: "gzip" | "plain",
  target: ProjectFileTarget
): ProjectFileTarget {
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

function candidateDistance(candidate: ProjectFileTarget, target: ProjectFileTarget): number {
  if (candidate.kind === "project-file-offset" || target.kind === "project-file-offset") {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.abs(candidate.base64XmlOffset - target.base64XmlOffset) + Math.abs(candidate.binaryOffset - target.binaryOffset);
}

function extractLengthPrefixedUtf8Tokens(bytes: Uint8Array): Array<{ offset: number; byteLength: number; text: string }> {
  const tokens: Array<{ offset: number; byteLength: number; text: string }> = [];

  for (let offset = 0; offset < bytes.byteLength - 6; offset += 1) {
    const byteLength = readUint32LE(bytes, offset);
    const stringOffset = offset + 4;
    if (byteLength < 2 || byteLength > 500 || stringOffset + byteLength > bytes.byteLength) {
      continue;
    }

    const text = tryDecodeUtf8(bytes.subarray(stringOffset, stringOffset + byteLength))?.trim();
    if (!text) {
      continue;
    }
    if (!looksLikeTokenText(text)) {
      continue;
    }

    tokens.push({ offset: stringOffset, byteLength, text });
  }

  return tokens;
}

function extractLengthPrefixedUtf8TextBlocks(
  bytes: Uint8Array
): Array<{ lengthOffset: number; offset: number; byteLength: number; text: string }> {
  const blocks: Array<{ lengthOffset: number; offset: number; byteLength: number; text: string }> = [];

  for (let lengthOffset = 0; lengthOffset < bytes.byteLength - 6; lengthOffset += 1) {
    const byteLength = readUint32LE(bytes, lengthOffset);
    const stringOffset = lengthOffset + 4;
    if (byteLength < 2 || byteLength > 250000 || stringOffset + byteLength > bytes.byteLength) {
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

function applyBase64Edits(
  edits: Array<{
    base64XmlOffset: number;
    expectedBase64: string;
    binaryOffset: number;
    lengthOffset?: number;
    byteLength: number;
    replacementBytes: Uint8Array;
    label: string;
  }>
): Array<{ offset: number; expected: string; replacement: string; label: string }> {
  const groups = new Map<string, typeof edits>();
  for (const edit of edits) {
    const key = `${edit.base64XmlOffset}:${edit.expectedBase64}`;
    const current = groups.get(key) ?? [];
    current.push(edit);
    groups.set(key, current);
  }

  return [...groups.values()]
    .map((group) => {
      const first = group[0];
      let bytes = decodeBase64(first.expectedBase64);
      if (!bytes) {
        throw new Error(`Could not decode base64 caption payload for ${first.label}.`);
      }

      for (const edit of group.sort((a, b) => b.binaryOffset - a.binaryOffset)) {
        const current = bytes.subarray(edit.binaryOffset, edit.binaryOffset + edit.byteLength);
        if (edit.lengthOffset === undefined && current.byteLength !== edit.replacementBytes.byteLength) {
          throw new Error(`Binary caption token changed before write: ${edit.label}`);
        }
        if (edit.lengthOffset === undefined) {
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
    })
    .sort((a, b) => b.offset - a.offset);
}

function nearbyLooksRelevant(nearbyXml: string, text: string): boolean {
  const nearby = nearbyXml.toLowerCase();
  if (nearby.includes("caption") || nearby.includes("subtitle") || nearby.includes("graphic") || nearby.includes("mogrt")) {
    return true;
  }
  return text.split(/\s+/).length >= 3 && /[.!?]?$/.test(text);
}

function dedupeCandidates(candidates: ProjectFileTarget[]): ProjectFileTarget[] {
  const seen = new Set<string>();
  const result: ProjectFileTarget[] = [];
  for (const candidate of candidates) {
    const key =
      candidate.kind === "project-file-offset"
        ? `${candidate.xmlOffset}:${candidate.encodedOriginal}`
        : `${candidate.base64XmlOffset}:${candidate.binaryOffset}:${candidate.decodedOriginal}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(candidate);
    }
  }
  return result;
}

function candidateLabel(candidate: ProjectFileTarget, index: number): string {
  if (candidate.kind === "project-file-base64-token") {
    return `Encoded caption token ${index + 1} · binary offset ${candidate.binaryOffset}`;
  }
  if (candidate.kind === "project-file-base64-string") {
    return `Caption block ${index + 1} · binary offset ${candidate.binaryOffset}`;
  }

  const objectName = /(?:Name|ObjectName)="([^"]+)"/.exec(candidate.nearbyXml)?.[1];
  const prefix = objectName ? decodeXml(objectName) : `Project string ${index + 1}`;
  return `${prefix} · XML offset ${candidate.xmlOffset}`;
}

function transcriptCandidateLabel(candidate: ProjectFileTarget, index: number): string {
  if (candidate.kind === "project-file-base64-token" || candidate.kind === "project-file-base64-string") {
    return `Transcript block ${index + 1} · binary offset ${candidate.binaryOffset}`;
  }
  return `Transcript string ${index + 1} · XML offset ${candidate.xmlOffset}`;
}

function isTranscriptProjectTarget(target: ProjectFileTarget): boolean {
  if (target.kind === "project-file-offset") {
    return /transcriptdata/i.test(target.nearbyXml);
  }
  return /transcriptdata/i.test(target.nearbyXml);
}

function projectTargetId(candidate: ProjectFileTarget): string {
  if (candidate.kind === "project-file-base64-token" || candidate.kind === "project-file-base64-string") {
    return `project-file:${candidate.base64XmlOffset}:${candidate.binaryOffset}:${hashString(candidate.decodedOriginal)}`;
  }
  return `project-file:${candidate.xmlOffset}:${hashString(candidate.decodedOriginal)}`;
}

function groupByProjectTarget(issues: Issue[]): Array<{ target: TextTarget; issues: Issue[] }> {
  const map = new Map<string, { target: TextTarget; issues: Issue[] }>();
  for (const issue of issues) {
    const current = map.get(issue.targetId) ?? { target: issue.target, issues: [] };
    current.issues.push(issue);
    map.set(issue.targetId, current);
  }
  return [...map.values()];
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function encodeXml(originalEncoded: string, value: string): string {
  const quoteEncoded = originalEncoded.includes("&quot;");
  const apostropheEncoded = originalEncoded.includes("&apos;");
  let encoded = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  if (quoteEncoded || originalEncoded.includes("\"")) {
    encoded = encoded.replace(/"/g, "&quot;");
  }
  if (apostropheEncoded) {
    encoded = encoded.replace(/'/g, "&apos;");
  }
  return encoded;
}

function compactXml(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 1200);
}

function looksLikeTokenText(value: string): boolean {
  if (!looksLikeHumanText(value) || value.length > 120) {
    return false;
  }
  return /^[\p{L}\p{N}][\p{L}\p{N}\p{M}.,!?;:’'\-]*$/u.test(value);
}

function looksLikeCaptionTextBlock(value: string): boolean {
  const text = value.trim();
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
    return false;
  }
  return text.includes(" ") || text.includes("\r") || text.includes("\n") || text.split(/\s+/).length > 1;
}

function dedupeTextBlocks(
  blocks: Array<{ lengthOffset: number; offset: number; byteLength: number; text: string }>
): Array<{ lengthOffset: number; offset: number; byteLength: number; text: string }> {
  const ordered = [...blocks].sort((a, b) => b.byteLength - a.byteLength);
  const selected: typeof blocks = [];
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

function selectCaptionTextBlocks(
  blocks: Array<{ lengthOffset: number; offset: number; byteLength: number; text: string }>
): Array<{ lengthOffset: number; offset: number; byteLength: number; text: string }> {
  if (blocks.length <= 1) {
    return blocks;
  }

  const best = [...blocks].sort((a, b) => captionBlockScore(b) - captionBlockScore(a))[0];
  return best ? [best] : [];
}

function selectTranscriptTextBlocks(
  blocks: Array<{ lengthOffset: number; offset: number; byteLength: number; text: string }>
): Array<{ lengthOffset: number; offset: number; byteLength: number; text: string }> {
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

function captionBlockScore(block: { offset: number; text: string }): number {
  const text = block.text.trim();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasLineBreak = /[\r\n]/.test(text) ? 50 : 0;
  return block.offset + wordCount * 25 + hasLineBreak;
}

function transcriptBlockScore(block: { offset: number; byteLength: number; text: string }): number {
  const words = block.text.trim().split(/\s+/).filter(Boolean).length;
  const lineBreaks = (block.text.match(/[\r\n]+/g) ?? []).length;
  const quality = transcriptTextQualityScore(block.text);
  return block.byteLength + words * 8 + lineBreaks * 16 + quality * 24;
}

function looksLikeTranscriptTextBlock(value: string): boolean {
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

function transcriptTextQualityScore(value: string): number {
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

function replaceLengthPrefixedUtf8Block(
  bytes: Uint8Array,
  lengthOffset: number,
  stringOffset: number,
  byteLength: number,
  replacementBytes: Uint8Array
): Uint8Array {
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

function spliceBytes(bytes: Uint8Array, offset: number, deleteLength: number, replacement: Uint8Array): Uint8Array {
  const next = new Uint8Array(bytes.byteLength - deleteLength + replacement.byteLength);
  next.set(bytes.subarray(0, offset), 0);
  next.set(replacement, offset);
  next.set(bytes.subarray(offset + deleteLength), offset + replacement.byteLength);
  return next;
}

function tryDecodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return strFromU8(bytes);
  } catch {
    return undefined;
  }
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const clean = value.replace(/\s+/g, "");
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    const output = new Uint8Array((clean.length * 3) / 4 - padding);
    let buffer = 0;
    let bits = 0;
    let out = 0;

    for (const char of clean) {
      if (char === "=") {
        break;
      }
      const value = base64Alphabet.indexOf(char);
      if (value < 0) {
        return undefined;
      }
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        output[out] = (buffer >> bits) & 0xff;
        out += 1;
      }
    }

    return output;
  } catch {
    return undefined;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    result += base64Alphabet[(chunk >> 18) & 63];
    result += base64Alphabet[(chunk >> 12) & 63];
    result += index + 1 < bytes.byteLength ? base64Alphabet[(chunk >> 6) & 63] : "=";
    result += index + 2 < bytes.byteLength ? base64Alphabet[chunk & 63] : "=";
  }
  return result;
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
