import type { Issue, TextReplacement } from "./models";

export function applyReplacement(text: string, replacement: TextReplacement): string {
  return text.slice(0, replacement.start) + replacement.replacement + text.slice(replacement.end);
}

export function applyIssueSet(original: string, issues: Issue[]): string {
  const dedupedIssues = dedupeIssuesByReplacement(issues);
  const selectedIssues = selectNonOverlappingIssues(dedupedIssues);
  const replacements = selectedIssues
    .map((issue) => issue.replacement)
    .sort((a, b) => b.start - a.start || b.end - a.end);

  return replacements.reduce((current, replacement) => applyReplacement(current, replacement), original);
}

export function makeIssueId(targetId: string, ruleId: string, start: number, end: number): string {
  return `${targetId}:${ruleId}:${start}:${end}`;
}

export function computeReplacementsFromTexts(original: string, corrected: string): TextReplacement[] {
  if (original === corrected) {
    return [];
  }

  const n = original.length;
  const m = corrected.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (original[i] === corrected[j]) {
        lcs[i][j] = 1 + lcs[i + 1][j + 1];
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  type Op = { kind: "equal" | "insert" | "delete"; value: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (original[i] === corrected[j]) {
      ops.push({ kind: "equal", value: original[i] });
      i += 1;
      j += 1;
      continue;
    }

    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "delete", value: original[i] });
      i += 1;
    } else {
      ops.push({ kind: "insert", value: corrected[j] });
      j += 1;
    }
  }

  while (i < n) {
    ops.push({ kind: "delete", value: original[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "insert", value: corrected[j] });
    j += 1;
  }

  const replacements: TextReplacement[] = [];
  let originalIndex = 0;
  let changeStart = -1;
  let inserted = "";

  const flush = (): void => {
    if (changeStart < 0) {
      return;
    }
    replacements.push({
      start: changeStart,
      end: originalIndex,
      replacement: inserted
    });
    changeStart = -1;
    inserted = "";
  };

  for (const op of ops) {
    if (op.kind === "equal") {
      flush();
      originalIndex += 1;
      continue;
    }

    if (changeStart < 0) {
      changeStart = originalIndex;
    }

    if (op.kind === "delete") {
      originalIndex += 1;
    } else {
      inserted += op.value;
    }
  }

  flush();
  return dedupeReplacements(replacements);
}

function dedupeReplacements(replacements: TextReplacement[]): TextReplacement[] {
  const seen = new Set<string>();
  const result: TextReplacement[] = [];
  for (const replacement of replacements) {
    const key = `${replacement.start}:${replacement.end}:${replacement.replacement}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(replacement);
    }
  }
  return result;
}

function dedupeIssuesByReplacement(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const result: Issue[] = [];
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

function selectNonOverlappingIssues(issues: Issue[]): Issue[] {
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

  const selected: Issue[] = [];
  for (const candidate of sorted) {
    const overlapsSelected = selected.some((existing) => rangesOverlap(existing.replacement, candidate.replacement));
    if (!overlapsSelected) {
      selected.push(candidate);
    }
  }
  return selected;
}

function rangesOverlap(left: TextReplacement, right: TextReplacement): boolean {
  return left.start < right.end && right.start < left.end;
}

function issueTypeScore(issue: Issue): number {
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
