# Validation record

Built on Linux x64 on 2026-10-15. This describes evidence from this workspace, not an assertion that a Windows CI run or clean-machine test has occurred.

## Automated checks

Version 0.3.0: `npm run check` checks JavaScript syntax. `npm test` passes **32 tests**, covering literal source-label inference and matching, unique-example verification, rejecting ambiguous/mismatched examples, source labels with punctuation, new values in later documents in both quality modes, project scope, missed-field flags, saved drafts, protecting corrections during reanalysis, clearing protection, retention cleanup of feedback, v2/v3 database migration, dynamic fields, aligned tables and label/value pairs, high accuracy invoice layout, preservation of repeated and empty table cells, total mismatch and unknown-header warnings, real native parsing of a synthetic ten-line-item invoice, analysis settings, failed reanalysis preserving reviewed results, CSV quoting and formula protection, managed input copies, per-project duplicate detection, incremental schema expansion, manual field additions and corrections, retention after durable export, missing/blocked CSV handling, watched-folder stability and replacements, retry, restart recovery, portable data-folder relocation, database corruption, SQLite connection settings, bulk-history pagination, parser timeout, and native PDF parsing. Storage uses the disk-backed SQLite engine embedded in the bundled desktop runtime.

A privately supplied invoice was compared locally: Standard discovered three fields, including an incorrect heading pair; High accuracy discovered 17 fields, retained all ten line items, and verified their sum against the stated total. This is a focused regression check, not a claim of accuracy across all documents. The supplied PDF and its identifying values are excluded from the repository, fixtures, and distribution artifacts; public regression fixtures are synthetic.

The smoke workflow exercises actual source-text selection, opening the teaching helper, naming a new field, verifying a source label, saving the field and draft through IPC, flagging an incorrect value, reanalyzing from inside Review while protecting a manual correction, blocking reviewed status until flags are resolved, and extracting a different value from a later native PDF with the saved rule. It also exercises renderer project and quick-conversion creation, isolated native PDF parsing, high accuracy layout extraction, preserving ten repeated line-item values through multiline review and CSV export, new-field detection, preserved CSV rows, reviewing and correcting a field through IPC, OCR of an image-only input using the bundled English model, and renderer Node isolation. The expected unresolved-flag rejection is intentionally exercised and can appear in the smoke log. The CI container test explicitly disables Chromium's OS sandbox; the distributed app does not. System D-Bus messages occur in the headless environment and do not fail the smoke check.

The Linux AppImage also passes that end-to-end workflow through its actual launcher, both using normal FUSE mounting and with `APPIMAGE_EXTRACT_AND_RUN=1` (without FUSE). Each test uses a separate AppImage copy in a directory containing spaces and verifies that its default SQLite database is created beside the original AppImage rather than inside the temporary mount or extracted payload. AppImageLauncher integration is disabled for these automated checks to avoid host desktop integration dialogs. Headless checks use the same CI-only Chromium sandbox override described above; the production AppImage launcher does not add `--no-sandbox`.

## Distribution checks

Windows x64 portable EXE and ZIP, Linux x64 tar.gz, and Linux x86_64 AppImage builds are generated in `release/`. The AppImage uses electron-builder's pinned `appimage` toolset 1.0.3 with the static type-2 runtime, which supports extraction mode without a FUSE installation. The Windows unpacked executable manifest requests `asInvoker`; the portable launcher requests the user execution level. The Windows bundle includes the native `.node` binding, `pdfium.dll`, English OCR model, and application-local `MSVCP140` / `VCRUNTIME140` DLLs. The Microsoft runtime distribution and OCR model are SHA-256 verified during preparation. No redistributable installer is run on end-user machines.

The dependency import table of the upstream Windows native addon was inspected. It imports the C++ runtime DLLs that the build now bundles. This verifies packaging intent; it does not replace execution on a clean Windows installation.

An additional Windows-on-Wine attempt did not complete the smoke test in the headless graphics environment (DRI/EGL/DirectComposition errors). No Windows runtime pass is claimed from that attempt.

## Remaining target-machine checks

- Run the supplied Windows CI job and packaged smoke test on Windows.
- On a clean Windows 11 x64 account without administrative rights or developer runtimes, run both the portable EXE and extracted ZIP with networking disabled. Check PDFs and scanned images, watch-folder imports, CSV corrections, retention, and restart recovery.
- Exercise Excel file locking and output paths with spaces and non-ASCII characters on Windows; the core test simulates an unavailable destination, rather than an actual Excel lock.
- Test supported Linux desktop distributions with their normal Chromium sandbox configuration. The local host is an Arch-derived distribution; the supplied CI targets Ubuntu 24.04.
- Validate discovery on more representative real documents. High accuracy adds common invoice layout rules and native table extraction; unlabeled or complex layouts can still require manual additions and corrections.
- macOS build, signing, and notarization are future work. Windows artifacts are currently unsigned.

`README.md` documents the retention tradeoff: after local content removal, the existing CSV is required to preserve old rows during later schema expansion. Restore that CSV if it goes missing; Portal refuses to overwrite it with an incomplete export.
