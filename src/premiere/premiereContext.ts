import type { CapabilityReport } from "../domain/models";
import { Logger } from "../domain/logger";

export interface PremiereContext {
  ppro: any;
  project?: any;
  sequence?: any;
  projectName?: string;
  projectPath?: string;
  sequenceName?: string;
  capability: CapabilityReport;
}

export async function getPremiereContext(logger: Logger): Promise<PremiereContext> {
  const ppro = require("premierepro");
  const capability: CapabilityReport = {
    activeProject: false,
    activeSequence: false,
    captionTracks: "unknown",
    captionTextRead: "unknown",
    captionTextWrite: "unknown",
    graphicTextRead: "unknown",
    graphicTextWrite: "unknown",
    projectFileFallback: "unknown",
    notes: []
  };

  const project = await ppro.Project.getActiveProject();
  capability.activeProject = Boolean(project);
  if (!project) {
    capability.notes.push("No active Premiere project returned by Project.getActiveProject().");
    return { ppro, capability };
  }

  const sequence = await project.getActiveSequence();
  capability.activeSequence = Boolean(sequence);
  if (!sequence) {
    capability.notes.push("No active sequence returned by project.getActiveSequence().");
  }

  const projectName = readString(project.name) ?? "Untitled Project";
  const projectPath = readString(project.path);
  const sequenceName = readString(sequence?.name);

  logger.info("Resolved Premiere context.", { projectName, projectPath, sequenceName });

  return {
    ppro,
    project,
    sequence,
    projectName,
    projectPath,
    sequenceName,
    capability
  };
}

export async function saveAndBackupProject(
  context: PremiereContext,
  copyFile: (source: string, destination: string) => Promise<void>,
  backupPathFor: (projectPath: string) => string,
  logger: Logger
): Promise<string | undefined> {
  if (!context.projectPath) {
    logger.warn("Skipping backup because the active project has no file path.");
    return undefined;
  }

  if (typeof context.project?.save === "function") {
    logger.info("Saving active project before backup.");
    await context.project.save();
  }

  const backupPath = backupPathFor(context.projectPath);
  await copyFile(context.projectPath, backupPath);
  return backupPath;
}

export function clipTrackItemType(ppro: any): number {
  return (
    ppro?.Constants?.TrackItemType?.CLIP ??
    ppro?.Constants?.TrackItemType?.Clip ??
    ppro?.constants?.TrackItemType?.CLIP ??
    ppro?.constants?.TrackItemType?.Clip ??
    1
  );
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function tryCall<T>(label: string, fn: () => T | Promise<T>, logger: Logger): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    logger.debug(`${label} failed.`, stringifyError(error));
    return undefined;
  }
}

export function stringifyError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? "" };
  }
  return { name: "Error", message: String(error) };
}
