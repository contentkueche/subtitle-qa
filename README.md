# Subtitle QA

Production-oriented Adobe Premiere Pro UXP plugin scaffold for native subtitle QA. The cutter stays inside Premiere: no SRT upload flow, no external web app, no copy-paste workflow.

## What the MVP Does

- Adds a `Subtitle QA` panel in Premiere Pro.
- Provides a `Clean Transcript (OpenAI)` first-pass button and a `Check Subtitles` fallback button.
- Scans the active project and active sequence through Premiere UXP.
- Detects native caption-track capability at runtime.
- Scans official graphic/text component parameters when accessible.
- Falls back to backed-up `.prproj` XML inspection when caption text is not exposed through official APIs.
- Uses official `Transcript` API first for full transcript scan/apply when available.
- In fallback mode, scans caption `FormattedTextData` blocks for subtitle checks and transcript `TranscriptData` blocks for transcript cleanup.
- Runs a local mock spelling, grammar, punctuation, and glossary engine.
- Optional OpenAI-powered spelling check (with local fallback if API is unavailable).
- Supports language mode selection: `Auto`, `German`, `English`.
- Shows issues with accept/reject controls.
- Applies accepted fixes.
- Creates a project backup before mutation.
- Uses one rolling backup per project (`<Project>.subtitle-qa-backup.prproj`) and overwrites it on each new apply cycle (avoids backup spam).
- Includes a debug screen with capability and fallback details.
- Supports an in-panel glossary editor (add/remove/save) with optional JSON import.

## Current Premiere UXP Reality

As of the current public Premiere UXP docs checked on 2026-05-11, `Project`, `Sequence`, `CaptionTrack`, video tracks, track items, component chains, and component params are public. `CaptionTrack.getTrackItems(trackItemType, includeEmptyTrackItems)` exists, but public caption text read/write APIs are not documented. Adobe staff have also stated that caption property APIs are still under construction.

The plugin therefore follows this order:

1. Try official transcript export/import APIs for `Clean Transcript (OpenAI)`.
2. Try official/native caption text methods if the installed Premiere build exposes them.
3. Scan graphic/text clip component params through official APIs.
4. If caption/transcript text is not natively accessible, save and duplicate the `.prproj`, decompress/read XML, locate supported caption text blocks, and write accepted corrections back with a backup.
5. If no path works, report `caption format unsupported` in the panel and show debug information.

See [docs/API_INVESTIGATION.md](docs/API_INVESTIGATION.md) for the specific APIs and source links.

## Project Structure

- `plugin/manifest.json`: Premiere UXP manifest with a panel entrypoint.
- `plugin/index.html`: UXP panel markup.
- `plugin/styles.css`: Native-feeling panel styles.
- `src/premiere/nativeScanner.ts`: Official API capability detection and scanner.
- `src/premiere/projectFileFallback.ts`: `.prproj` gzip/plain XML fallback reader/writer.
- `src/premiere/applyFixes.ts`: Backup and accepted-fix application.
- `src/domain/mockCorrectionEngine.ts`: Local mock QA engine.
- `src/domain/glossary.ts`: Glossary JSON parser/default glossary.
- `src/ui/panel.ts`: Issue list, accept/reject/apply, debug UI.

## Install Dependencies

```zsh
npm install
```

## Build

```zsh
npm run build
```

The UXP plugin bundle is written to `dist/`.

## Load in Premiere Pro

1. Open the Adobe UXP Developer Tool.
2. Add Plugin.
3. Select the generated `dist/manifest.json`.
4. Load the plugin.
5. In Premiere Pro, open `Window > UXP Plugins > Subtitle QA`.

## OpenAI QA Modes (Optional)

1. In the panel, set `Spelling Engine` to either:
   - `OpenAI Spelling` (spelling-focused), or
   - `OpenAI Full QA` (sentence-level spelling + grammar + punctuation + spacing).
   - Open `Debug > Engine Settings` to configure this once, then collapse it.
2. Paste your OpenAI API key.
3. Keep the model as `gpt-4.1-mini` (or set another model).
4. Click `Save Engine`.
5. Run `Clean Transcript (OpenAI)` first, then use `Check Subtitles` as fallback.

Behavior:
- `OpenAI Spelling` is context-aware (it sees neighboring subtitle lines and sentence meaning).
- `OpenAI Full QA` applies sentence-level corrections with minimal-edit guidance.
- OpenAI spelling edits are filtered to orthography-safe character changes (to avoid punctuation drift in spelling mode).
- In `Local Spelling` and `OpenAI Spelling` modes, grammar/punctuation/glossary stay local.
- In `OpenAI Full QA` mode, OpenAI drives sentence-level corrections; glossary checks are still merged in locally.
- If OpenAI fails (network/key/rate limit), Subtitle QA logs the error and automatically falls back to local spelling.

Engine settings are stored per machine in plugin data as:
- `subtitle-qa-engine-settings.json`

## Test the MVP

1. Open a `.prproj` with an active sequence.
2. Add captions and/or text graphics containing test text such as:
   - `teh quick test`
   - `premier pro`
   - `Dont leave double  spaces`
3. Open the `Subtitle QA` panel.
4. Click `Clean Transcript (OpenAI)` first.
5. Accept or reject individual issues.
6. Click `Apply Accepted`.
7. Optionally run `Check Subtitles` as a final pass.
8. Confirm a backup file appears next to the project:
   - `Project.subtitle-qa-backup.prproj`

## Glossary JSON Format

```json
{
  "brandTerms": [
    {
      "term": "premier pro",
      "preferred": "Premiere Pro",
      "caseSensitive": false,
      "note": "Adobe product spelling"
    }
  ]
}
```

Use `Glossary` in the panel to open the glossary editor.
- Add terms directly in the panel and click `Save Glossary`.
- The production glossary lives in SharePoint:
  `contentkueche / Dokumente / General / 00_COMPANY_BRAIN / subtitle-qa-glossary.json`
- The plugin reads/writes that file through the local OneDrive/SharePoint sync path when available.
- If auto-discovery does not find the synced file, click `Import JSON` once and choose the synced SharePoint file. The plugin remembers that path in `subtitle-qa-glossary-settings.json`.
- If the shared file is unavailable, the plugin falls back to the local plugin-data glossary.

Optional per-term language scoping:

```json
{
  "brandTerms": [
    {
      "term": "inbox",
      "preferred": "Posteingang",
      "language": "de"
    },
    {
      "term": "premier pro",
      "preferred": "Premiere Pro",
      "language": "en"
    }
  ]
}
```

If `language` is omitted, the term is applied in both language modes.

## Correction Engine Architecture

- Local fallback engine: `src/domain/mockCorrectionEngine.ts`
- OpenAI spelling adapter: `src/domain/openAiSpellingEngine.ts`
- Generic HTTP seam: `src/domain/correctionEngineAdapter.ts`

Panel workflow stays unchanged: scan native Premiere text, produce issues, accept/reject, backup, apply.

## Safety Notes

- Official API writes are performed through Premiere transaction actions when available.
- Project-file fallback writes only after a backup is created.
- The fallback parser is deliberately conservative and logs unsupported formats instead of silently editing unknown binary data.
- Transcript cleanup uses `TranscriptData` payloads by design; subtitle checks continue to use caption/graphic sources.
- The fallback attempts to ask Premiere to reopen the patched project file after writing, keeping the workflow inside Premiere rather than requiring manual export/import.
