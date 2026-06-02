import type { ApplyResult, Issue, TextTarget } from "../domain/models";
import { Logger } from "../domain/logger";
import { applyIssueSet } from "../domain/textEdits";
import { UxpFileSystem } from "../platform/fileSystem";
import { PremiereContext, saveAndBackupProject, stringifyError } from "./premiereContext";
import { ProjectFileFallback } from "./projectFileFallback";
import { TranscriptApiBridge } from "./transcriptApi";

export class FixApplier {
  private readonly backupByScanKey = new Map<string, string | undefined>();

  constructor(
    private readonly fs: UxpFileSystem,
    private readonly fallback: ProjectFileFallback,
    private readonly transcriptApi: TranscriptApiBridge,
    private readonly logger: Logger
  ) {}

  async apply(
    context: PremiereContext,
    issues: Issue[],
    options: { backupReuseKey?: string; allowTranscriptStructureChanges?: boolean } = {}
  ): Promise<ApplyResult> {
    const accepted = issues.filter((issue) => issue.status === "accepted");
    if (accepted.length === 0) {
      return { appliedCount: 0, mode: "none", message: "No accepted issues to apply." };
    }

    const scanBackupKey = buildScanBackupKey(context.projectPath, options.backupReuseKey);
    let backupPath: string | undefined;
    if (scanBackupKey && this.backupByScanKey.has(scanBackupKey)) {
      backupPath = this.backupByScanKey.get(scanBackupKey);
      this.logger.info("Reusing existing backup for this scan.", { backupPath });
    } else {
      backupPath = await saveAndBackupProject(
        context,
        (source, destination) => this.fs.copyFile(source, destination),
        (projectPath) => this.fs.backupPathFor(projectPath),
        this.logger
      );
      if (scanBackupKey) {
        this.backupByScanKey.set(scanBackupKey, backupPath);
      }
    }

    const nativeIssues = accepted.filter((issue) => issue.target.source === "graphic-text" || issue.target.source === "native-caption");
    const transcriptApiIssues = accepted.filter((issue) => issue.target.source === "transcript-api");
    const projectFileIssues = accepted.filter((issue) => issue.target.source === "project-file");

    let appliedCount = 0;
    if (nativeIssues.length > 0) {
      appliedCount += await this.applyNative(context, nativeIssues);
    }

    if (transcriptApiIssues.length > 0) {
      appliedCount += await this.transcriptApi.apply(context, transcriptApiIssues, {
        allowStructureChanges: options.allowTranscriptStructureChanges === true
      });
    }

    if (projectFileIssues.length > 0) {
      if (!context.projectPath) {
        throw new Error("Cannot apply project-file fallback because the active project has no path.");
      }
      await this.fallback.apply(context.projectPath, projectFileIssues);
      appliedCount += projectFileIssues.length;
      await this.tryReloadProject(context);
    }

    return {
      appliedCount,
      backupPath,
      mode: projectFileIssues.length > 0 ? "project-file-fallback" : "official-api",
      message: `Applied ${appliedCount} accepted fix${appliedCount === 1 ? "" : "es"}.`
    };
  }

  private async applyNative(context: PremiereContext, issues: Issue[]): Promise<number> {
    const groups = groupByTarget(issues);
    const actions: any[] = [];

    for (const { target, issues: targetIssues } of groups) {
      const correctedText = applyIssueSet(target.originalText, targetIssues);
      const action = await createNativeSetTextAction(target, correctedText);
      if (action) {
        actions.push(action);
        continue;
      }

      const appliedDirectly = await applyDirectCaptionMutation(target, correctedText);
      if (!appliedDirectly) {
        throw new Error(`No writable official Premiere text API for ${target.label}.`);
      }
    }

    if (actions.length > 0) {
      if (typeof context.project?.executeTransaction !== "function") {
        throw new Error("Premiere project does not expose executeTransaction().");
      }

      await context.project.executeTransaction((compoundAction: any) => {
        for (const action of actions) {
          compoundAction.addAction(action);
        }
      }, "Subtitle QA: Apply accepted subtitle fixes");
    }

    return issues.length;
  }

  private async tryReloadProject(context: PremiereContext): Promise<void> {
    if (!context.projectPath || typeof context.ppro?.Project?.open !== "function") {
      this.logger.warn("Project-file fallback wrote the project file, but this host cannot reload it automatically.");
      return;
    }

    try {
      await this.closeCurrentProjectWithoutSaving(context);
      await openProjectWithFallback(context, this.logger);
      this.logger.info("Reopened the patched project file in Premiere.", { projectPath: context.projectPath });
    } catch (error) {
      this.logger.warn("Patched project file was written, but automatic reload failed.", stringifyError(error));
    }
  }

  private async closeCurrentProjectWithoutSaving(context: PremiereContext): Promise<void> {
    if (typeof context.project?.close !== "function") {
      return;
    }

    this.logger.info("Closing current project before reopening patched project file.");
    const closeOptions = createCloseProjectOptions(context.ppro);
    if (closeOptions) {
      try {
        await context.project.close(closeOptions);
        return;
      } catch (error) {
        this.logger.warn("Project close with options failed; retrying without options.", stringifyError(error));
      }
    }
    await context.project.close();
  }
}

function buildScanBackupKey(projectPath: string | undefined, reuseKey: string | undefined): string | undefined {
  if (!projectPath || !reuseKey) {
    return undefined;
  }
  return `${projectPath}::${reuseKey}`;
}

async function openProjectWithFallback(context: PremiereContext, logger: Logger): Promise<void> {
  const openOptions = createOpenProjectOptions(context.ppro);
  if (openOptions) {
    try {
      await context.ppro.Project.open(context.projectPath, openOptions);
      return;
    } catch (error) {
      logger.warn("Project open with options failed; retrying without options.", stringifyError(error));
    }
  }
  await context.ppro.Project.open(context.projectPath);
}

function createOpenProjectOptions(ppro: any): any {
  const options = instantiateOption(ppro?.OpenProjectOptions);
  if (!options) {
    return undefined;
  }

  options.setShowConvertProjectDialog?.(false);
  options.setShowLocateFileDialog?.(false);
  options.setShowWarningDialog?.(false);
  options.setAddToMRUList?.(false);
  return options;
}

function createCloseProjectOptions(ppro: any): any {
  const options = instantiateOption(ppro?.CloseProjectOptions);
  if (!options) {
    return undefined;
  }

  options.setPromptIfDirty?.(false);
  options.setShowCancelButton?.(false);
  options.setSaveWorkspace?.(false);
  options.setIsAppBeingPreparedToQuit?.(false);
  return options;
}

function instantiateOption(OptionCtor: any): any | undefined {
  if (typeof OptionCtor !== "function") {
    return undefined;
  }

  try {
    return new OptionCtor();
  } catch {
    try {
      return OptionCtor();
    } catch {
      return undefined;
    }
  }
}

function groupByTarget(issues: Issue[]): Array<{ target: TextTarget; issues: Issue[] }> {
  const map = new Map<string, { target: TextTarget; issues: Issue[] }>();
  for (const issue of issues) {
    const current = map.get(issue.targetId) ?? { target: issue.target, issues: [] };
    current.issues.push(issue);
    map.set(issue.targetId, current);
  }
  return [...map.values()];
}

async function createNativeSetTextAction(target: TextTarget, correctedText: string): Promise<any | undefined> {
  const native = target.native;
  if (!native) {
    return undefined;
  }

  if (native.kind === "component-param" && native.param?.createKeyframe && native.param?.createSetValueAction) {
    const keyframe = await native.param.createKeyframe(correctedText);
    return native.param.createSetValueAction(keyframe, false);
  }

  if (native.kind === "caption-method" && native.trackItem) {
    if (native.trackItem.createSetTextAction) {
      return native.trackItem.createSetTextAction(correctedText);
    }
    if (native.trackItem.createSetCaptionTextAction) {
      return native.trackItem.createSetCaptionTextAction(correctedText);
    }
  }

  return undefined;
}

async function applyDirectCaptionMutation(target: TextTarget, correctedText: string): Promise<boolean> {
  const item = target.native?.trackItem;
  if (!item) {
    return false;
  }

  if (typeof item.setText === "function") {
    await item.setText(correctedText);
    return true;
  }
  if (typeof item.setCaptionText === "function") {
    await item.setCaptionText(correctedText);
    return true;
  }
  if ("text" in item) {
    item.text = correctedText;
    return true;
  }

  return false;
}
