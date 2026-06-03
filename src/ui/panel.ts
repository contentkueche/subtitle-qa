import type { Glossary, Issue, IssueStatus, OpenAiSpellingSettings, ScanLanguage, ScanResult, SpellingEngineMode } from "../domain/models";
import { Logger } from "../domain/logger";
import { defaultGlossary, parseGlossaryJson } from "../domain/glossary";
import { MockCorrectionEngine } from "../domain/mockCorrectionEngine";
import { OpenAiSpellingEngine } from "../domain/openAiSpellingEngine";
import { UxpFileSystem } from "../platform/fileSystem";
import { NativePremiereScanner } from "../premiere/nativeScanner";
import { ProjectFileFallback } from "../premiere/projectFileFallback";
import { FixApplier } from "../premiere/applyFixes";
import type { PremiereContext } from "../premiere/premiereContext";
import { TranscriptApiBridge } from "../premiere/transcriptApi";
import { encodeUtf8 } from "../platform/utf8";
import { applyReplacement } from "../domain/textEdits";

interface GlossarySettings {
  sharedPath?: string;
  sharePointUrl: string;
}

const CENTRAL_GLOSSARY_SHAREPOINT_URL =
  "https://contentkueche.sharepoint.com/sites/contentkueche/Freigegebene%20Dokumente/General/00_COMPANY_BRAIN/subtitle-qa-glossary.json";

export class SubtitleQAPanel {
  private readonly logger = new Logger();
  private readonly fs = new UxpFileSystem(this.logger);
  private readonly nativeScanner = new NativePremiereScanner(this.logger);
  private readonly fallback = new ProjectFileFallback(this.fs, this.logger);
  private readonly transcriptApi = new TranscriptApiBridge(this.logger);
  private readonly mockEngine = new MockCorrectionEngine();
  private readonly openAiSpelling = new OpenAiSpellingEngine();
  private readonly applier = new FixApplier(this.fs, this.fallback, this.transcriptApi, this.logger);

  private glossary: Glossary = defaultGlossary;
  private glossarySettings: GlossarySettings = defaultGlossarySettings();
  private openAiSettings: OpenAiSpellingSettings = defaultOpenAiSpellingSettings();
  private scanResult?: ScanResult;
  private context?: PremiereContext;
  private scanLanguage: ScanLanguage = "auto";
  private scanRunKey = createScanRunKey();
  private readonly reviewedDisplayKeys = new Set<string>();
  private glossaryLoaded = false;
  private glossarySettingsLoaded = false;

  constructor(private readonly root: Document) {
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

  private bindEvents(): void {
    this.cleanTranscriptButton.addEventListener("click", () => this.cleanTranscript());
    this.checkButton.addEventListener("click", () => this.checkSubtitles());
    this.emptyTranscriptButton.addEventListener("click", () => this.cleanTranscript());
    this.emptyCheckButton.addEventListener("click", () => this.checkSubtitles());
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

  private async checkSubtitles(): Promise<void> {
    await this.runScan("subtitle");
  }

  private async cleanTranscript(): Promise<void> {
    await this.runScan("transcript");
  }

  private async runScan(workflow: "subtitle" | "transcript"): Promise<void> {
    this.setBusy(true, workflow === "transcript" ? "Scanning transcript for cleanup..." : "Scanning active Premiere sequence...");
    this.logger.clear();
    this.reviewedDisplayKeys.clear();
    this.scanRunKey = createScanRunKey();

    try {
      const nativeScan = await this.nativeScanner.scan();
      this.context = nativeScan.context;
      const targets =
        workflow === "transcript" ? await this.loadTranscriptTargets(nativeScan.context) : await this.loadSubtitleTargets(nativeScan);
      const issues = await this.checkIssues(targets, workflow);
      this.scanResult = {
        projectName: nativeScan.context.projectName,
        projectPath: nativeScan.context.projectPath,
        sequenceName: nativeScan.context.sequenceName,
        capability: nativeScan.context.capability,
        targets,
        issues
      };

      if (targets.length === 0) {
        this.statusText.textContent =
          workflow === "transcript"
            ? "Transcript cleanup unsupported in this project format. Open Debug for details."
            : "Caption format unsupported. Open Debug for capability details.";
        this.logger.warn(
          workflow === "transcript" ? "Transcript cleanup unsupported." : "Caption format unsupported.",
          nativeScan.context.capability
        );
      } else {
        const writableIssues = issues.filter((issue) => isWritableIssue(issue)).length;
        const reviewOnlyIssues = issues.length - writableIssues;
        this.statusText.textContent = `Found ${issues.length} issue${issues.length === 1 ? "" : "s"} in ${targets.length} text item${
          targets.length === 1 ? "" : "s"
        } (${languageLabel(this.scanLanguage)} / ${spellingModeLabel(this.workflowEngineMode(workflow))})${
          reviewOnlyIssues > 0 ? `, ${writableIssues} writable` : ""
        }.`;
      }
    } catch (error) {
      this.statusText.textContent = "Scan failed. Open Debug for details.";
      this.logger.error("Scan failed.", serializeError(error));
    } finally {
      this.setBusy(false);
      this.render();
    }
  }

  private async loadSubtitleTargets(nativeScan: { context: PremiereContext; targets: Issue["target"][] }): Promise<Issue["target"][]> {
    const targets = [...nativeScan.targets];
    const shouldTryProjectFile =
      nativeScan.context.projectPath &&
      nativeScan.context.capability.captionTracks !== "unavailable" &&
      nativeScan.context.capability.captionTextRead !== "available";

    if (shouldTryProjectFile && nativeScan.context.projectPath) {
      this.logger.info("Native caption text is not accessible; trying project-file fallback.");
      try {
        if (typeof nativeScan.context.project?.save === "function") {
          this.logger.info("Saving active project before project-file fallback scan.");
          await nativeScan.context.project.save();
        }
        const fallbackTargets = await this.fallback.scan(nativeScan.context.projectPath, nativeScan.context.sequenceName);
        targets.push(...fallbackTargets);
        nativeScan.context.capability.projectFileFallback = fallbackTargets.length > 0 ? "available" : "unavailable";
        if (fallbackTargets.length === 0) {
          nativeScan.context.capability.notes.push("Project-file fallback did not find caption or graphic text candidates in the active project.");
        }
      } catch (error) {
        nativeScan.context.capability.projectFileFallback = "unavailable";
        nativeScan.context.capability.notes.push(error instanceof Error ? error.message : String(error));
        this.logger.warn("Project-file fallback scan failed.", serializeError(error));
      }
    } else {
      nativeScan.context.capability.projectFileFallback = targets.some((target) => target.source === "project-file")
        ? "available"
        : "not-needed";
    }

    return targets;
  }

  private async loadTranscriptTargets(context: PremiereContext): Promise<Issue["target"][]> {
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

      // Prefer project-file transcript blocks for full transcript cleanup.
      // They allow structural edits (insert/delete tokens), while the current
      // official Transcript action path is constrained by token structure.
      try {
        const transcriptTargets = await this.fallback.scanTranscript(context.projectPath, context.sequenceName);
        if (transcriptTargets.length > 0) {
          context.capability.projectFileFallback = "available";
          context.capability.notes.push("Using project-file transcript blocks for full transcript cleanup.");
          this.logger.info("Using project-file transcript targets for cleanup.", {
            targets: transcriptTargets.length
          });
          return transcriptTargets;
        }
      } catch (error) {
        this.logger.warn("Project-file transcript scan failed; trying official Transcript API.", serializeError(error));
      }

      try {
        const apiTargets = await this.transcriptApi.scan(context);
        if (apiTargets.length > 0) {
          context.capability.projectFileFallback = "not-needed";
          context.capability.notes.push("Using official Transcript API for transcript cleanup.");
          return apiTargets;
        }
        this.logger.warn("Official Transcript API did not return text segments; falling back to project-file scan.");
      } catch (error) {
        this.logger.warn("Official Transcript API scan failed; falling back to project-file scan.", serializeError(error));
      }

      context.capability.notes.push("Project-file transcript scan did not find writable transcript blocks.");
      this.logger.warn("TranscriptData not writable in this project; falling back to caption text blocks.");
      const captionTargets = await this.fallback.scan(context.projectPath, context.sequenceName);
      if (captionTargets.length > 0) {
        context.capability.projectFileFallback = "available";
        context.capability.notes.push("Used caption text blocks as transcript-cleanup fallback.");
        return captionTargets;
      }

      context.capability.projectFileFallback = "unavailable";
      return [];
    } catch (error) {
      context.capability.projectFileFallback = "unavailable";
      context.capability.notes.push(error instanceof Error ? error.message : String(error));
      this.logger.warn("Project-file transcript scan failed.", serializeError(error));
      return [];
    }
  }

  private async applyAccepted(): Promise<void> {
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

      let backupPath: string | undefined;
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
        this.statusText.textContent = reviewOnlyAcceptedBeforeApply.length > 0
          ? `Accepted ${reviewOnlyAcceptedBeforeApply.length} review-only issue${
              reviewOnlyAcceptedBeforeApply.length === 1 ? "" : "s"
            }. Auto-apply skipped because Premiere requires token-stable transcript edits.`
          : "Apply finished, but no accepted fixes could be written.";
      } else {
        this.statusText.textContent =
          `Applied ${totalApplied} accepted fix${totalApplied === 1 ? "" : "es"}${backupPath ? ` (backup: ${backupPath})` : ""}.` +
          (remainingManual > 0
            ? ` ${remainingManual} accepted review-only issue${remainingManual === 1 ? "" : "s"} still need manual apply.`
            : "");
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

  private async openGlossaryEditor(): Promise<void> {
    await this.ensureGlossaryLoaded(false);
    this.renderGlossaryEditor();
    this.setGlossaryEditorVisible(true);
    this.statusText.textContent = `Glossary editor opened (${this.glossary.brandTerms.length} terms).`;
  }

  private async ensureGlossaryLoaded(silent: boolean): Promise<void> {
    if (this.glossaryLoaded) {
      return;
    }

    const defaultJson = `${JSON.stringify(defaultGlossary, null, 2)}\n`;
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

  private async ensureGlossarySettingsLoaded(): Promise<void> {
    if (this.glossarySettingsLoaded) {
      return;
    }

    const defaultText = `${JSON.stringify(defaultGlossarySettings(), null, 2)}\n`;
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

  private async loadSharedGlossaryIfAvailable(): Promise<{ name: string; text: string; location: string } | undefined> {
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
      return undefined;
    }

    this.glossarySettings = { ...this.glossarySettings, sharedPath: discoveredPath };
    await this.saveGlossarySettings();
    return {
      name: "subtitle-qa-glossary.json",
      text: await this.fs.readTextFile(discoveredPath),
      location: discoveredPath
    };
  }

  private addGlossaryTerm(): void {
    const term = this.glossaryTermInput.value.trim();
    const preferred = this.glossaryPreferredInput.value.trim();
    if (!term || !preferred) {
      this.statusText.textContent = "Glossary term and preferred value are required.";
      return;
    }

    const languageRaw = this.glossaryLanguageInput.value;
    const language = languageRaw === "de" || languageRaw === "en" ? languageRaw : undefined;
    const note = this.glossaryNoteInput.value.trim();
    const caseSensitive = this.glossaryCaseSensitiveInput.checked;

    const duplicateIndex = this.glossary.brandTerms.findIndex(
      (entry) =>
        entry.term.toLowerCase() === term.toLowerCase() &&
        (entry.language ?? "all") === (language ?? "all") &&
        entry.preferred.toLowerCase() === preferred.toLowerCase()
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
          note: note.length > 0 ? note : undefined
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

  private removeGlossaryTerm(index: number): void {
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

  private async saveGlossaryEditor(): Promise<void> {
    try {
      await this.ensureGlossaryLoaded(true);
      const text = `${JSON.stringify(this.glossary, null, 2)}\n`;
      await this.ensureGlossarySettingsLoaded();
      const saved = this.glossarySettings.sharedPath
        ? await this.saveSharedGlossary(text)
        : await this.fs.saveStandardGlossary(text);
      this.statusText.textContent = `Saved ${this.glossarySettings.sharedPath ? "shared" : "local"} glossary (${
        this.glossary.brandTerms.length
      } terms).`;
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

  private async importGlossaryJson(): Promise<void> {
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

  private async saveSharedGlossary(text: string): Promise<{ name: string; location?: string }> {
    const sharedPath = this.glossarySettings.sharedPath;
    if (!sharedPath) {
      throw new Error("No shared glossary path is configured.");
    }
    await this.fs.writeTextFile(sharedPath, text);
    return { name: "subtitle-qa-glossary.json", location: sharedPath };
  }

  private async saveGlossarySettings(): Promise<void> {
    const text = `${JSON.stringify(this.glossarySettings, null, 2)}\n`;
    await this.fs.saveGlossarySettings(text);
  }

  private setGlossaryEditorVisible(visible: boolean): void {
    this.glossaryEditor.classList.toggle("visible", visible);
    this.loadGlossaryButton.textContent = visible ? "Glossary (Open)" : "Glossary";
  }

  private renderGlossaryEditor(): void {
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

  private onLanguageChanged(): void {
    const selected = this.languageMode.value;
    if (selected === "de" || selected === "en" || selected === "auto") {
      this.scanLanguage = selected;
      this.statusText.textContent = `Language set to ${languageLabel(this.scanLanguage)}.`;
      this.logger.info("Updated scan language mode.", { language: this.scanLanguage });
    }
  }

  private async checkIssues(targets: Issue["target"][], workflow: "subtitle" | "transcript"): Promise<Issue[]> {
    const localIssues = dedupeIssues(this.mockEngine.checkTargets(targets, this.glossary, this.scanLanguage));
    const mode = this.workflowEngineMode(workflow);
    if (mode === "local") {
      return localIssues;
    }

    try {
      const remoteIssues = dedupeIssues(
        await this.openAiSpelling.checkTargetsWithGlossary(targets, this.scanLanguage, {
          ...this.openAiSettings,
          mode
        }, this.glossary)
      );
      if (mode === "openai_full") {
        const localFallbackIssues = selectLocalFallbackIssues(localIssues);
        const remoteRanges = new Set(
          remoteIssues.map((issue) => `${issue.targetId}:${issue.replacement.start}:${issue.replacement.end}`)
        );
        const localNonOverlapping = localFallbackIssues.filter(
          (issue) => !remoteRanges.has(`${issue.targetId}:${issue.replacement.start}:${issue.replacement.end}`)
        );
        const merged = dedupeIssues([...remoteIssues, ...localNonOverlapping]);
        this.logger.info(workflow === "transcript" ? "OpenAI transcript cleanup complete." : "OpenAI full sentence QA complete.", {
          mode,
          localFallbackIssues: localFallbackIssues.length,
          remoteIssues: remoteIssues.length,
          mergedIssues: merged.length
        });
        return merged;
      }

      const localNonSpelling = localIssues.filter((issue) => issue.type !== "spelling");
      const merged = dedupeIssues([...localNonSpelling, ...remoteIssues]);
      this.logger.info("OpenAI spelling check complete.", {
        mode: "openai",
        localSpelling: localIssues.filter((issue) => issue.type === "spelling").length,
        remoteSpelling: remoteIssues.length
      });
      return merged;
    } catch (error) {
      this.logger.warn("OpenAI QA failed; using local fallback.", serializeError(error));
      this.statusText.textContent = "OpenAI QA failed; used local fallback.";
      return localIssues;
    }
  }

  private workflowEngineMode(workflow: "subtitle" | "transcript"): SpellingEngineMode {
    if (workflow === "transcript") {
      return "openai_full";
    }
    return this.openAiSettings.mode;
  }

  private onSpellingModeChanged(): void {
    const selected = this.spellingEngineMode.value;
    if (selected === "local" || selected === "openai" || selected === "openai_full") {
      this.openAiSettings.mode = selected;
      this.toggleOpenAiInputs(selected !== "local");
      this.statusText.textContent = `Spelling engine set to ${spellingModeLabel(selected)}. Save to persist.`;
    }
  }

  private async loadEngineSettings(): Promise<void> {
    const defaults = defaultOpenAiSpellingSettings();
    const defaultText = `${JSON.stringify(defaults, null, 2)}\n`;
    try {
      const loaded = await this.fs.loadOrCreateEngineSettings(defaultText);
      const parsed = parseOpenAiSpellingSettings(loaded.text, defaults);
      this.openAiSettings = parsed;
      this.hydrateEngineSettingsUi();
      this.toggleOpenAiInputs(this.openAiSettings.mode !== "local");
      this.logger.info("Loaded spelling engine settings.", {
        mode: this.openAiSettings.mode,
        model: this.openAiSettings.model,
        location: loaded.location ?? "plugin-data"
      });
    } catch (error) {
      this.openAiSettings = defaults;
      this.hydrateEngineSettingsUi();
      this.toggleOpenAiInputs(false);
      this.logger.warn("Could not load spelling engine settings; using defaults.", serializeError(error));
    }
  }

  private async saveOpenAiSettings(): Promise<void> {
    try {
      const modeValue = this.spellingEngineMode.value;
      this.openAiSettings = {
        mode: modeValue === "openai_full" ? "openai_full" : modeValue === "openai" ? "openai" : "local",
        apiKey: this.openAiApiKey.value.trim(),
        model: this.openAiModel.value.trim() || "gpt-4.1-mini"
      };
      const text = `${JSON.stringify(this.openAiSettings, null, 2)}\n`;
      const saved = await this.fs.saveEngineSettings(text);
      this.statusText.textContent = `Saved spelling engine settings (${spellingModeLabel(this.openAiSettings.mode)}).`;
      this.logger.info("Saved spelling engine settings.", {
        mode: this.openAiSettings.mode,
        model: this.openAiSettings.model,
        location: saved.location ?? "plugin-data"
      });
      this.setEngineSettingsPanelVisible(false);
    } catch (error) {
      this.statusText.textContent = "Could not save spelling engine settings. Open Debug for details.";
      this.logger.error("Saving spelling engine settings failed.", serializeError(error));
    }
  }

  private toggleEngineSettings(): void {
    const shouldShow = !this.engineSettingsPanel.classList.contains("visible");
    this.setEngineSettingsPanelVisible(shouldShow);
  }

  private setEngineSettingsPanelVisible(visible: boolean): void {
    this.engineSettingsPanel.classList.toggle("visible", visible);
    this.toggleEngineSettingsButton.textContent = visible ? "Hide Engine Settings" : "Engine Settings";
  }

  private hydrateEngineSettingsUi(): void {
    this.spellingEngineMode.value = this.openAiSettings.mode;
    this.openAiApiKey.value = this.openAiSettings.apiKey;
    this.openAiModel.value = this.openAiSettings.model;
    this.toggleOpenAiInputs(this.openAiSettings.mode !== "local");
  }

  private toggleOpenAiInputs(enabled: boolean): void {
    this.openAiApiKey.disabled = !enabled;
    this.openAiModel.disabled = !enabled;
  }

  private setAll(status: "accepted" | "rejected"): void {
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
      this.statusText.textContent =
        status === "accepted"
          ? `Accepted ${changed} pending fix${changed === 1 ? "" : "es"}. Click Apply Accepted to write them.`
          : `Rejected ${changed} pending issue${changed === 1 ? "" : "s"}.`;
    } else {
      this.statusText.textContent = "No pending issues changed.";
    }
    this.render();
  }

  private setIssueStatus(issueId: string, status: Extract<IssueStatus, "pending" | "accepted" | "rejected">): void {
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

  private render(): void {
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

  private renderIssue(issue: Issue): HTMLElement {
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
    message.textContent = isWritableIssue(issue)
      ? issue.message
      : `${issue.message} ${nonWritableReason(issue)}`;

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

  private renderReviewedIssue(issue: Issue): HTMLElement {
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

  private showTab(tab: "issues" | "debug"): void {
    this.issuesTab.classList.toggle("active", tab === "issues");
    this.debugTab.classList.toggle("active", tab === "debug");
    this.issuesView.classList.toggle("active", tab === "issues");
    this.debugView.classList.toggle("active", tab === "debug");
  }

  private selectDebug(): void {
    try {
      this.debugLog.focus();
      this.debugLog.select();
      this.statusText.textContent = "Debug log selected. Press Cmd+C to copy it.";
    } catch (error) {
      this.statusText.textContent = "Could not select debug log.";
      this.logger.warn("Select debug log failed.", serializeError(error));
    }
  }

  private setDebugLogText(text: string): void {
    this.debugLog.value = text;
  }

  private setEmptyStateText(allIssues: Issue[], visibleIssues: Issue[], reviewedIssues: Issue[]): void {
    const message = this.emptyState.querySelector("p");
    if (!message) {
      return;
    }

    if (!this.scanResult || allIssues.length === 0) {
      message.textContent = "Start with Clean Transcript (OpenAI), then use Check Subtitles as a fallback pass.";
    } else if (visibleIssues.length === 0 && reviewedIssues.length > 0) {
      message.textContent = "All pending issues are reviewed. Adjust decisions below or apply accepted fixes.";
    } else {
      message.textContent = "All pending issues are reviewed.";
    }
  }

  private setBusy(isBusy: boolean, message?: string): void {
    this.cleanTranscriptButton.disabled = isBusy;
    this.checkButton.disabled = isBusy;
    this.emptyTranscriptButton.disabled = isBusy;
    this.emptyCheckButton.disabled = isBusy;
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

  private setApplyButtonsDisabled(disabled: boolean): void {
    this.applyButton.disabled = disabled;
  }

  private logManualApplyQueue(issues: Issue[]): void {
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

  private get checkButton(): HTMLButtonElement {
    return getElement(this.root, "checkButton");
  }

  private get cleanTranscriptButton(): HTMLButtonElement {
    return getElement(this.root, "cleanTranscriptButton");
  }

  private get emptyCheckButton(): HTMLButtonElement {
    return getElement(this.root, "emptyCheckButton");
  }

  private get emptyTranscriptButton(): HTMLButtonElement {
    return getElement(this.root, "emptyTranscriptButton");
  }

  private get acceptAllButton(): HTMLButtonElement {
    return getElement(this.root, "acceptAllButton");
  }

  private get rejectAllButton(): HTMLButtonElement {
    return getElement(this.root, "rejectAllButton");
  }

  private get applyButton(): HTMLButtonElement {
    return getElement(this.root, "applyButton");
  }

  private get loadGlossaryButton(): HTMLButtonElement {
    return getElement(this.root, "loadGlossaryButton");
  }

  private get glossaryEditor(): HTMLElement {
    return getElement(this.root, "glossaryEditor");
  }

  private get glossaryList(): HTMLElement {
    return getElement(this.root, "glossaryList");
  }

  private get glossaryTermInput(): HTMLInputElement {
    return getElement(this.root, "glossaryTermInput");
  }

  private get glossaryPreferredInput(): HTMLInputElement {
    return getElement(this.root, "glossaryPreferredInput");
  }

  private get glossaryLanguageInput(): HTMLSelectElement {
    return getElement(this.root, "glossaryLanguageInput");
  }

  private get glossaryCaseSensitiveInput(): HTMLInputElement {
    return getElement(this.root, "glossaryCaseSensitiveInput");
  }

  private get glossaryNoteInput(): HTMLInputElement {
    return getElement(this.root, "glossaryNoteInput");
  }

  private get glossaryAddButton(): HTMLButtonElement {
    return getElement(this.root, "glossaryAddButton");
  }

  private get glossarySaveButton(): HTMLButtonElement {
    return getElement(this.root, "glossarySaveButton");
  }

  private get glossaryImportButton(): HTMLButtonElement {
    return getElement(this.root, "glossaryImportButton");
  }

  private get glossaryCloseButton(): HTMLButtonElement {
    return getElement(this.root, "glossaryCloseButton");
  }

  private get languageMode(): HTMLSelectElement {
    return getElement(this.root, "languageMode");
  }

  private get spellingEngineMode(): HTMLSelectElement {
    return getElement(this.root, "spellingEngineMode");
  }

  private get openAiApiKey(): HTMLInputElement {
    return getElement(this.root, "openAiApiKey");
  }

  private get openAiModel(): HTMLInputElement {
    return getElement(this.root, "openAiModel");
  }

  private get saveOpenAiSettingsButton(): HTMLButtonElement {
    return getElement(this.root, "saveOpenAiSettingsButton");
  }

  private get toggleEngineSettingsButton(): HTMLButtonElement {
    return getElement(this.root, "toggleEngineSettingsButton");
  }

  private get engineSettingsPanel(): HTMLElement {
    return getElement(this.root, "engineSettingsPanel");
  }

  private get selectDebugButton(): HTMLButtonElement {
    return getElement(this.root, "selectDebugButton");
  }

  private get issuesTab(): HTMLButtonElement {
    return getElement(this.root, "issuesTab");
  }

  private get debugTab(): HTMLButtonElement {
    return getElement(this.root, "debugTab");
  }

  private get issuesView(): HTMLElement {
    return getElement(this.root, "issuesView");
  }

  private get debugView(): HTMLElement {
    return getElement(this.root, "debugView");
  }

  private get issueList(): HTMLOListElement {
    return getElement(this.root, "issueList");
  }

  private get emptyState(): HTMLElement {
    return getElement(this.root, "emptyState");
  }

  private get debugLog(): HTMLTextAreaElement {
    return getElement(this.root, "debugLog");
  }

  private get statusText(): HTMLElement {
    return getElement(this.root, "statusText");
  }

  private get issueCount(): HTMLElement {
    return getElement(this.root, "issueCount");
  }

  private get acceptedCount(): HTMLElement {
    return getElement(this.root, "acceptedCount");
  }

  private get sourceMode(): HTMLElement {
    return getElement(this.root, "sourceMode");
  }
}

function copyBlock(document: Document, label: string, text: string): HTMLElement {
  const block = document.createElement("div");
  block.className = "copy-block";
  const caption = document.createElement("span");
  caption.className = "copy-label";
  caption.textContent = label;
  const content = document.createElement("div");
  content.textContent = text;
  block.append(caption, content);
  return block;
}

function changedText(issue: Issue): string {
  return issuePreview(issue, "before");
}

function replacementText(issue: Issue): string {
  return issuePreview(issue, "after");
}

function displayChangeText(text: string, emptyLabel: string): string {
  if (text.length === 0) {
    return emptyLabel;
  }
  if (/^\s+$/.test(text)) {
    return `${text.length} space${text.length === 1 ? "" : "s"}`;
  }
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function insertionLocationLabel(issue: Issue): string {
  const position = issue.replacement.start;
  const source = issue.originalText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (position >= source.length) {
    return `(insert at end, char ${position})`;
  }

  const before = source.slice(Math.max(0, position - 12), position).replace(/\n/g, " / ");
  const after = source.slice(position, Math.min(source.length, position + 12)).replace(/\n/g, " / ");
  const left = before.length > 0 ? before : "start";
  const right = after.length > 0 ? after : "end";
  return `(insert at char ${position}: "${left}" | "${right}")`;
}

function issuePreview(issue: Issue, mode: "before" | "after"): string {
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

function displayToken(text: string, emptyLabel: string): string {
  if (text.length === 0) {
    return emptyLabel;
  }
  if (/^\s+$/.test(text)) {
    return `${text.length} space${text.length === 1 ? "" : "s"}`;
  }
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " / ");
}

function contextSnippet(issue: Issue): string {
  const text = issue.originalText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const start = Math.max(0, issue.replacement.start - 40);
  const end = Math.min(text.length, issue.replacement.end + 40);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < text.length ? " ..." : "";
  return `Context: ${prefix}${text.slice(start, end).replace(/\n/g, " / ")}${suffix}`;
}

function issueDisplayKey(issue: Issue): string {
  return [issue.type, issue.message, changedText(issue), replacementText(issue)].join("\u001f");
}

function clearChildren(element: HTMLElement): void {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

function getElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing UI element #${id}`);
  }
  return element as T;
}

function labelForIssue(issue: Issue): string {
  const labels: Record<Issue["type"], string> = {
    spelling: "Spelling",
    grammar: "Grammar",
    punctuation: "Punctuation",
    glossary: "Glossary"
  };
  return labels[issue.type];
}

function sourceMode(result?: ScanResult): string {
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

function languageLabel(language: ScanLanguage): string {
  const labels: Record<ScanLanguage, string> = {
    auto: "Auto",
    de: "German",
    en: "English"
  };
  return labels[language];
}

function spellingModeLabel(mode: SpellingEngineMode): string {
  if (mode === "openai_full") {
    return "OpenAI Full QA";
  }
  if (mode === "openai") {
    return "OpenAI Spelling";
  }
  return "Local";
}

function defaultOpenAiSpellingSettings(): OpenAiSpellingSettings {
  return {
    mode: "local",
    apiKey: "",
    model: "gpt-4.1-mini"
  };
}

function parseOpenAiSpellingSettings(raw: string, fallback: OpenAiSpellingSettings): OpenAiSpellingSettings {
  const parsed = JSON.parse(raw) as Partial<OpenAiSpellingSettings>;
  const mode = parsed.mode === "openai_full" ? "openai_full" : parsed.mode === "openai" ? "openai" : "local";
  return {
    mode,
    apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : fallback.apiKey,
    model: typeof parsed.model === "string" && parsed.model.trim().length > 0 ? parsed.model : fallback.model
  };
}

function defaultGlossarySettings(): GlossarySettings {
  return {
    sharePointUrl: CENTRAL_GLOSSARY_SHAREPOINT_URL
  };
}

function parseGlossarySettings(raw: string): GlossarySettings {
  const parsed = JSON.parse(raw) as Partial<GlossarySettings>;
  return {
    sharedPath: typeof parsed.sharedPath === "string" && parsed.sharedPath.trim().length > 0 ? parsed.sharedPath : undefined,
    sharePointUrl:
      typeof parsed.sharePointUrl === "string" && parsed.sharePointUrl.trim().length > 0
        ? parsed.sharePointUrl
        : CENTRAL_GLOSSARY_SHAREPOINT_URL
  };
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const result: Issue[] = [];
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

function selectLocalFallbackIssues(issues: Issue[]): Issue[] {
  return issues.filter((issue) => {
    if (issue.type === "glossary") {
      return true;
    }
    if (issue.type === "punctuation" && issue.ruleId === "punctuation-terminal-mark") {
      return false;
    }
    return true;
  });
}

function projectIssueScope(issue: Issue): string {
  const projectFile = issue.target.projectFile;
  if (!projectFile) {
    return issue.targetId;
  }
  if (projectFile.kind === "project-file-offset") {
    return `xml:${projectFile.xmlOffset}`;
  }
  return `base64:${projectFile.base64XmlOffset}:${projectFile.decodedOriginal}`;
}

function serializeError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? "" };
  }
  return { name: "Error", message: String(error) };
}

function isWritableIssue(issue: Issue): boolean {
  if (issue.target.source === "transcript-api") {
    const corrected = applyReplacement(issue.originalText, issue.replacement);
    return transcriptTokenStructureCompatible(issue.originalText, corrected);
  }

  const target = issue.target.projectFile;
  if (target?.kind !== "project-file-base64-token") {
    return true;
  }
  return encodeUtf8(issue.suggestedText).byteLength === target.byteLength;
}

function nonWritableReason(issue: Issue): string {
  if (issue.target.source === "transcript-api") {
    return "This item is review-only in this mode because the correction changes transcript token structure (word merge/split), which Premiere will reject for this import path.";
  }

  return "This item is review-only for now because Premiere stored it in a fixed-length binary caption payload.";
}

function transcriptTokenStructureCompatible(originalText: string, correctedText: string): boolean {
  const originalTokens = tokenizeWords(originalText);
  const correctedTokens = tokenizeWords(correctedText);
  if (originalTokens.length === 0 || correctedTokens.length === 0) {
    return false;
  }
  if (originalTokens.length !== correctedTokens.length) {
    return false;
  }

  for (let index = 0; index < originalTokens.length; index += 1) {
    if (isPunctuationToken(originalTokens[index]) !== isPunctuationToken(correctedTokens[index])) {
      return false;
    }
  }

  return true;
}

function tokenizeWords(text: string): string[] {
  const tokens = text.match(/[^\s]+/g);
  return tokens ? [...tokens] : [];
}

function isPunctuationToken(token: string): boolean {
  return /^[,.;:!?'"“”‘’()\-–—/…]+$/.test(token);
}

function createScanRunKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
