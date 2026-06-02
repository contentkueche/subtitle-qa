import type { CapabilityReport, TextTarget } from "../domain/models";
import { Logger } from "../domain/logger";
import { clipTrackItemType, getPremiereContext, PremiereContext, tryCall } from "./premiereContext";

const captionAccessors = ["getText", "getCaptionText", "getTextContent", "getContent", "getValue"];
const captionMutators = ["createSetTextAction", "createSetCaptionTextAction", "setText", "setCaptionText"];

export interface NativeScan {
  context: PremiereContext;
  targets: TextTarget[];
}

export class NativePremiereScanner {
  constructor(private readonly logger: Logger) {}

  async scan(): Promise<NativeScan> {
    const context = await getPremiereContext(this.logger);
    const targets: TextTarget[] = [];

    if (!context.sequence) {
      return { context, targets };
    }

    await this.scanCaptionTracks(context, targets);
    await this.scanGraphicText(context, targets);

    if (context.capability.captionTracks === "available" && context.capability.captionTextRead !== "available") {
      context.capability.notes.push(
        "Caption tracks are present, but public caption text access is not available in this Premiere UXP build."
      );
    }

    return { context, targets };
  }

  private async scanCaptionTracks(context: PremiereContext, targets: TextTarget[]): Promise<void> {
    const { sequence, ppro, capability } = context;
    const count = await tryCall("sequence.getCaptionTrackCount()", () => sequence.getCaptionTrackCount(), this.logger);
    if (typeof count !== "number" || count <= 0) {
      capability.captionTracks = typeof count === "number" ? "unavailable" : "unknown";
      capability.captionTextRead = "unavailable";
      capability.captionTextWrite = "unavailable";
      return;
    }

    capability.captionTracks = "available";
    const clipType = clipTrackItemType(ppro);
    let readAnyText = false;
    let writeAnyText = false;

    for (let trackIndex = 0; trackIndex < count; trackIndex += 1) {
      const track = await tryCall(`sequence.getCaptionTrack(${trackIndex})`, () => sequence.getCaptionTrack(trackIndex), this.logger);
      const items = await tryCall(
        `captionTrack.getTrackItems(${trackIndex})`,
        () => track?.getTrackItems(clipType, false),
        this.logger
      );
      if (!Array.isArray(items)) {
        continue;
      }

      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex];
        const textInfo = await readCaptionText(item, this.logger);
        if (!textInfo || !looksLikeHumanText(textInfo.text)) {
          continue;
        }

        readAnyText = true;
        const mutator = captionMutators.find((method) => typeof item?.[method] === "function");
        writeAnyText = writeAnyText || Boolean(mutator);

        targets.push({
          id: `caption:${trackIndex}:${itemIndex}`,
          source: "native-caption",
          label: `Caption track ${trackIndex + 1}, item ${itemIndex + 1}`,
          sequenceName: context.sequenceName,
          trackType: "caption",
          trackIndex,
          itemIndex,
          originalText: textInfo.text,
          confidence: mutator ? "high" : "medium",
          native: {
            kind: "caption-method",
            trackItem: item,
            accessor: textInfo.accessor,
            mutator
          }
        });
      }
    }

    capability.captionTextRead = readAnyText ? "available" : "unavailable";
    capability.captionTextWrite = writeAnyText ? "available" : "unavailable";
  }

  private async scanGraphicText(context: PremiereContext, targets: TextTarget[]): Promise<void> {
    const { sequence, ppro, capability } = context;
    const count = await tryCall("sequence.getVideoTrackCount()", () => sequence.getVideoTrackCount(), this.logger);
    if (typeof count !== "number" || count <= 0) {
      capability.graphicTextRead = "unavailable";
      capability.graphicTextWrite = "unavailable";
      return;
    }

    const clipType = clipTrackItemType(ppro);
    let readAnyText = false;
    let writeAnyText = false;

    for (let trackIndex = 0; trackIndex < count; trackIndex += 1) {
      const track = await tryCall(`sequence.getVideoTrack(${trackIndex})`, () => sequence.getVideoTrack(trackIndex), this.logger);
      const items = await tryCall(
        `videoTrack.getTrackItems(${trackIndex})`,
        () => track?.getTrackItems(clipType, false),
        this.logger
      );
      if (!Array.isArray(items)) {
        continue;
      }

      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex];
        const itemName = await tryCall("trackItem.getName()", () => item?.getName(), this.logger);
        const startTime = await tryCall("trackItem.getStartTime()", () => item?.getStartTime(), this.logger);
        const endTime = await tryCall("trackItem.getEndTime()", () => item?.getEndTime(), this.logger);
        const chain = await tryCall("trackItem.getComponentChain()", () => item?.getComponentChain(), this.logger);
        const componentCount = await tryCall("componentChain.getComponentCount()", () => chain?.getComponentCount(), this.logger);

        if (typeof componentCount !== "number") {
          continue;
        }

        for (let componentIndex = 0; componentIndex < componentCount; componentIndex += 1) {
          const component = await tryCall(
            `componentChain.getComponentAtIndex(${componentIndex})`,
            () => chain.getComponentAtIndex(componentIndex),
            this.logger
          );
          const componentName = await componentLabel(component, this.logger);
          const paramCount = await tryCall("component.getParamCount()", () => component?.getParamCount(), this.logger);
          if (typeof paramCount !== "number") {
            continue;
          }

          for (let paramIndex = 0; paramIndex < paramCount; paramIndex += 1) {
            const param = await tryCall(`component.getParam(${paramIndex})`, () => component.getParam(paramIndex), this.logger);
            const paramName = typeof param?.displayName === "string" ? param.displayName : `Param ${paramIndex + 1}`;
            const value = await readParamString(param, startTime, this.logger);

            if (!value || !looksLikeHumanText(value) || !isLikelyTextParam(paramName, componentName, value)) {
              continue;
            }

            readAnyText = true;
            const writable = typeof param?.createKeyframe === "function" && typeof param?.createSetValueAction === "function";
            writeAnyText = writeAnyText || writable;

            targets.push({
              id: `graphic:${trackIndex}:${itemIndex}:${componentIndex}:${paramIndex}`,
              source: "graphic-text",
              label: `${itemName || "Graphic"} · ${componentName} · ${paramName}`,
              sequenceName: context.sequenceName,
              trackType: "video",
              trackIndex,
              itemIndex,
              componentIndex,
              paramIndex,
              startTicks: tickString(startTime),
              endTicks: tickString(endTime),
              originalText: value,
              confidence: writable ? "high" : "medium",
              native: {
                kind: "component-param",
                trackItem: item,
                component,
                param,
                startTime
              }
            });
          }
        }
      }
    }

    capability.graphicTextRead = readAnyText ? "available" : "unavailable";
    capability.graphicTextWrite = writeAnyText ? "available" : "unavailable";
  }
}

async function readCaptionText(item: any, logger: Logger): Promise<{ accessor: string; text: string } | undefined> {
  for (const accessor of captionAccessors) {
    if (typeof item?.[accessor] !== "function") {
      continue;
    }
    const value = await tryCall(`captionItem.${accessor}()`, () => item[accessor](), logger);
    if (typeof value === "string") {
      return { accessor, text: value };
    }
  }

  if (typeof item?.text === "string") {
    return { accessor: "text", text: item.text };
  }

  return undefined;
}

async function readParamString(param: any, time: any, logger: Logger): Promise<string | undefined> {
  if (param && time && typeof param.getValueAtTime === "function") {
    const value = await tryCall("param.getValueAtTime()", () => param.getValueAtTime(time), logger);
    if (typeof value === "string") {
      return value;
    }
  }

  if (typeof param?.getStartValue === "function") {
    const keyframe = await tryCall("param.getStartValue()", () => param.getStartValue(), logger);
    if (typeof keyframe?.value === "string") {
      return keyframe.value;
    }
  }

  return undefined;
}

async function componentLabel(component: any, logger: Logger): Promise<string> {
  const displayName = await tryCall("component.getDisplayName()", () => component?.getDisplayName(), logger);
  if (typeof displayName === "string" && displayName) {
    return displayName;
  }
  const matchName = await tryCall("component.getMatchName()", () => component?.getMatchName(), logger);
  return typeof matchName === "string" && matchName ? matchName : "Component";
}

function isLikelyTextParam(paramName: string, componentName: string, value: string): boolean {
  const haystack = `${paramName} ${componentName}`.toLowerCase();
  return haystack.includes("text") || haystack.includes("caption") || haystack.includes("graphic") || value.split(/\s+/).length >= 2;
}

export function looksLikeHumanText(value: string): boolean {
  const text = value.trim();
  if (text.length < 2 || text.length > 5000) {
    return false;
  }
  if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(text)) {
    return false;
  }
  if (/^(?:[a-z]+:)?[/\\]/i.test(text) || /^[A-F0-9-]{24,}$/i.test(text)) {
    return false;
  }
  return true;
}

function tickString(value: any): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value.ticks === "string" || typeof value.ticks === "number") {
    return String(value.ticks);
  }
  return String(value);
}
