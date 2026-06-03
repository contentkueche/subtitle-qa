# Subtitle QA Release

## Current Release

- Version: `0.2.0`
- CCX: `release/com.subtitleqa.panel_premierepro.ccx`
- Manifest: `release/latest.json`
- Central glossary: `contentkueche / Dokumente / General / 00_COMPANY_BRAIN / subtitle-qa-glossary.json`

## GitHub Hosting

Commit these files to `github.com/contentkueche/subtitle-qa`:

```text
release/latest.json
release/com.subtitleqa.panel_premierepro.ccx
install/update-subtitle-qa.ps1
```

The updater reads:

```text
https://raw.githubusercontent.com/contentkueche/subtitle-qa/main/release/latest.json
```

If the repository is private, set a GitHub token on each Windows cutter PC before running the updater:

```powershell
setx SUBTITLE_QA_GITHUB_TOKEN "YOUR_TOKEN_HERE"
```

For a public release repository, no token is needed.

## Windows Cutter Install / Update

Run PowerShell on each cutter PC:

```powershell
powershell -ExecutionPolicy Bypass -File .\install\update-subtitle-qa.ps1
```

If a machine previously reported success but the panel does not appear in Premiere, force a reinstall:

```powershell
powershell -ExecutionPolicy Bypass -File .\install\update-subtitle-qa.ps1 -ForceReinstall
```

The script:

- downloads `latest.json`
- downloads the referenced `.ccx`
- verifies the SHA-256 hash
- finds Adobe `UnifiedPluginInstallerAgent.exe`
- installs the plugin through UPIA
- verifies that Adobe UPIA lists `Subtitle QA` after installation
- stores the installed version under `%LOCALAPPDATA%\Contentkueche\Subtitle QA`

Restart Premiere Pro after install/update.

## Updating To A New Version

1. Update `package.json` and `plugin/manifest.json`.
2. Run:

```bash
npm run typecheck
npm run build
```

3. Package/build the `.ccx`.
4. Replace `release/com.subtitleqa.panel_premierepro.ccx`.
5. Update `release/latest.json`:
   - `version`
   - `sha256`
   - `notes`
6. Commit and push to GitHub.
7. Run `install/update-subtitle-qa.ps1` on cutter PCs, or later wire it into startup/MDM.
