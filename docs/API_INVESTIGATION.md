# Premiere UXP API Investigation

Date: 2026-05-11

## Official public API surface checked

- Premiere UXP entrypoint: `const app = require("premierepro")`
- Active project: `await app.Project.getActiveProject()`
- Active sequence: `await project.getActiveSequence()`
- Project path for backup/fallback: `project.path`
- Caption track count/access: `sequence.getCaptionTrackCount()` and `sequence.getCaptionTrack(trackIndex)`
- Caption track items: `captionTrack.getTrackItems(Constants.TrackItemType.CLIP, false)`
- Video track count/access: `sequence.getVideoTrackCount()` and `sequence.getVideoTrack(trackIndex)`
- Video track items: `videoTrack.getTrackItems(Constants.TrackItemType.CLIP, false)`
- Graphic/text-like component params: `trackItem.getComponentChain()`, `component.getParamCount()`, `component.getParam(index)`, `param.getValueAtTime(time)`, `param.createKeyframe(value)`, `param.createSetValueAction(keyframe, false)`
- Undoable mutation: `project.executeTransaction(callback, undoString)`
- Project save: `project.save()`

## Findings

The public Premiere UXP docs expose caption tracks and track items, but the documented `CaptionTrack` object does not expose caption text read/write methods. Adobe staff confirmed in the public community thread that caption text APIs are still under construction; `getTrackItems(trackItemType, includeEmptyTrackItems)` can return caption track items, but there is no available public API to access or modify caption properties yet.

That means the MVP must detect three cases at runtime:

1. Future/native caption text methods exist in the installed Premiere build. Use them.
2. Native caption tracks exist but text is not exposed. Use the `.prproj` fallback.
3. Neither official APIs nor project-file fallback can identify supported text. Report `caption format unsupported` with debug detail.

## Project-file fallback notes

In the tested Premiere project, the Transcript panel text is stored in `TranscriptData` base64 payloads. Editing those tokens changes the Transcript panel only; it does not update the timeline caption clip. The actual caption clip text was found in a caption-track `Block` object referenced by `CaptionDataClipTrackItem > BlockVector > BlockVectorItem`, inside a `FormattedTextData` base64 payload.

The fallback therefore treats `FormattedTextData` as the supported caption-block target and skips `TranscriptData` and `CaptionDataTemplateStyle` payloads. This keeps the MVP from reporting transcript-only edits as successful subtitle edits.

## References

- Premiere UXP overview: https://developer.adobe.com/premiere-pro/uxp/
- Premiere UXP API overview: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/
- `Project`: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/project/
- `Sequence`: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/sequence/
- `CaptionTrack`: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/captiontrack/
- `VideoTrack`: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/videotrack/
- `VideoClipTrackItem`: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/videocliptrackitem/
- `ComponentParam`: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/componentparam/
- UXP manifest/panel entrypoints: https://developer.adobe.com/premiere-pro/uxp/plugins/concepts/manifest/
- Adobe community caption API status: https://community.adobe.com/t5/premiere-pro-discussions/issue-accessing-caption-items-via-captiontrack-api-in-premiere-pro-uxp-scripting/td-p/15432460
