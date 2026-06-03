# Subtitle QA

Production-oriented Adobe Premiere Pro UXP plugin for native transcript QA. The cutter stays inside Premiere: no SRT upload flow, no external web app, no copy-paste workflow.

## What the MVP Does

- Adds a `Subtitle QA` panel in Premiere Pro.
- Provides a `Check Transcript (OpenAI)` button.
- Scans the active project and active sequence through Premiere UXP without touching caption/graphic scan paths.
- Uses official `Transcript` API first for full transcript scan/apply when available.
- In fallback mode, scans transcript `TranscriptData` blocks only.
- Runs a local mock spelling, grammar, punctuation, and glossary engine.
- Uses OpenAI-powered full transcript cleanup with local fallback if the API is unavailable.
- Supports language mode selection: `Auto`, `German`, `English`.
- Shows issues with accept/reject controls.
- Applies accepted fixes.
- Creates a project backup before mutation.
- Uses one rolling backup per project (`<Project>.subtitle-qa-backup.prproj`) and overwrites it on each new apply cycle (avoids backup spam).
- Includes a debug screen with capability and fallback details.
- Supports an in-panel glossary editor (add/remove/save) with optional JSON import.

## Current Premiere UXP Reality

As of the current public Premiere UXP docs checked on 2026-05-11, official transcript export/import APIs are available in current Premiere builds, while public caption text write/generation APIs remain incomplete. The production workflow therefore focuses on cleaning the transcript first.

The plugin therefore follows this order:

1. Try official transcript export/import APIs for `Check Transcript (OpenAI)`.
2. If official transcript text is not accessible, inspect backed-up `.prproj` transcript data as a fallback.
3. If no transcript path works, report transcript cleanup unsupported with debug information.

See [docs/API_INVESTIGATION.md](docs/API_INVESTIGATION.md) for the specific APIs and source links.

## Project Structure

- `plugin/manifest.json`: Premiere UXP manifest with a panel entrypoint.
- `plugin/index.html`: UXP panel markup.
- `plugin/styles.css`: Native-feeling panel styles.
- `src/premiere/nativeScanner.ts`: Legacy caption/graphic scanner kept out of the production transcript workflow.
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

## OpenAI Transcript QA

1. Open `Debug > Engine Settings` once.
2. Paste your OpenAI API key.
3. Keep the model as `gpt-4.1-mini` (or set another model).
4. Click `Save Engine`.
5. Run `Check Transcript (OpenAI)`.

Behavior:
- OpenAI receives whole transcript segments with neighboring segment context and glossary terms.
- It returns one corrected transcript segment, not many tiny subtitle/caption patches.
- Apply rebuilds timed transcript JSON and verifies the import before confirming the write.
- If OpenAI fails (network/key/rate limit), Subtitle QA logs the error and falls back to local checks.

Engine settings are stored per machine in plugin data as:
- `subtitle-qa-engine-settings.json`

## Test the MVP

1. Open a `.prproj` with an active sequence.
2. Add or generate a transcript containing test text such as:
   - `teh quick test`
   - `premier pro`
   - `Dont leave double  spaces`
3. Open the `Subtitle QA` panel.
4. Click `Check Transcript (OpenAI)`.
5. Accept or reject individual issues.
6. Click `Apply Accepted`.
7. Confirm a backup file appears next to the project:
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
- OpenAI transcript cleanup adapter: `src/domain/openAiTranscriptCleanupEngine.ts`
- Legacy OpenAI spelling adapter: `src/domain/openAiSpellingEngine.ts`
- Generic HTTP seam: `src/domain/correctionEngineAdapter.ts`

Panel workflow: scan transcript, produce full-segment cleanup issues, accept/reject, backup, apply.

## Safety Notes

- Official API writes are performed through Premiere transaction actions when available.
- Project-file fallback writes only after a backup is created.
- The fallback parser is deliberately conservative and logs unsupported formats instead of silently editing unknown binary data.
- Transcript cleanup uses official Transcript API first and `TranscriptData` fallback only when needed.
- Caption/graphic subtitle checking is disabled in the production panel.
- The fallback attempts to ask Premiere to reopen the patched project file after writing, keeping the workflow inside Premiere rather than requiring manual export/import.
