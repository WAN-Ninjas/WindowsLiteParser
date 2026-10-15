# LiteParse Portal

A portable desktop application built around [LiteParse](https://github.com/run-llama/liteparse). Windows 11 x64 is the primary target. Linux x64 is available as an AppImage and an extracted archive. A macOS build target is present for future validation.

## Using the application

Download a Windows portable `.exe`, or extract the Windows ZIP and run **LiteParse Portal.exe**. No Node.js, Python, database server, LibreOffice, Tesseract installation, or administrator account is needed. The portable EXE expands bundled application files into a temporary directory at launch; project data stays beside the downloaded EXE. With a ZIP, keep the entire folder together.

On Linux, download the `.AppImage`, mark it executable, and launch it as your normal user:

```sh
chmod +x LiteParse-Portal-0.3.1-linux-x86_64.AppImage
./LiteParse-Portal-0.3.1-linux-x86_64.AppImage
```

The AppImage uses the pinned modern static runtime rather than the legacy FUSE 2 runtime. If FUSE mounting is unavailable, its built-in extraction mode runs without installing FUSE or using administrator permissions:

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./LiteParse-Portal-0.3.1-linux-x86_64.AppImage
```

Extraction mode unpacks to a temporary directory and cleans it up when the app closes. Project data stays beside the original AppImage in **LiteParse Portal Data**. You can alternatively extract the `.tar.gz` and launch `liteparse-portal`.

Both formats include Electron, the parser, PDFium, SQLite, and the English OCR model. Linux still needs a compatible desktop distribution's glibc, GTK, NSS, graphics/audio libraries, and working Chromium sandbox support. The tar.gz does not require FUSE. Neither format runs on every Linux distribution independently of system libraries. Do not launch the application as root. See the [AppImage extraction-mode documentation](https://docs.appimage.org/user-guide/troubleshooting/fuse.html#extract-and-run-type-2-appimages).

1. **Projects:** create a named project. Import one file, select multiple files, or import a folder recursively. Optionally choose a watched folder, including its subfolders. Folder polling runs every four seconds while the application is open and waits for two stable observations before importing a file.
2. **Automatic fields:** the first document establishes CSV columns from labeled values and layout. Later documents can add columns automatically. Existing rows are preserved, with blanks for fields they did not contain. Every completed document becomes one row. Repeated labeled values are joined with newlines in the same cell. High accuracy table columns preserve every row, including repeated values and empty cells, as matching lines within each cell. For example, ten invoice line items remain one document row with ten lines per line-item column.
3. **Review:** open a converted document, compare its fields with the extracted text, correct values, and add missed fields. Added fields become project columns. Every automatic extraction starts as **Needs review**, even when all fields appear filled.
4. **CSV:** each project maintains one CSV automatically. **Save CSV as…** chooses the file that future imports and corrections will update. The export includes document ID, filename, SHA-256, page count, import time, review status, and discovered fields. Keep this file under Portal's control; use copies for spreadsheet analysis. If Excel locks it, the app keeps the data in SQLite and retries updating the CSV.
5. **Quick conversions:** create a quick conversion for a single file or a batch. It uses the same automatic fields, review, retention, and CSV pipeline without a watched folder. History persists between sessions.
6. **Retention:** choose this when creating a project or change it in the project detail. **Keep document content long term** retains imported copies, page text, and extracted values. **Remove content after review & CSV export** deletes that content only after you mark a document reviewed and the CSV has been saved successfully. Unreviewed and failed documents stay available locally. Minimal IDs, content hashes, status, and timestamps remain for duplicate detection. Previously exported-only rows are read from the existing CSV when the schema expands. Keep that CSV backed up: its records cannot be reconstructed from the database after removal. Changing back to “keep” applies to remaining and future content; it cannot restore removed data. Deletion is logical deletion, not a secure disk wipe.
7. **Analysis quality:** new projects and quick conversions default to **High accuracy**, which uses positioned text, native table cells, PDF form fields, invoice layout rules, and 300 DPI English OCR for scans. **Standard** uses the original text discovery and 150 DPI OCR. Digital text is read directly; increasing OCR resolution helps scans rather than rewriting clear embedded text. Change **Analysis quality** in a project or conversion to affect waiting and future files. A running file finishes with its original setting.
8. **Reanalyze:** use the document's **Reanalyze** button or **Save draft & reanalyze** inside Review to apply the selected quality to a retained source without creating a duplicate. Existing CSV values remain available while it runs. Success refreshes automatic values and returns the document to **Needs review**; failure keeps the previous result and displays the error. Saved manual corrections and missed-field flags survive reanalysis. **Allow automatic extraction** under a corrected field releases its protection for a later reanalysis. Removed source content cannot be reanalyzed. Existing project columns remain to preserve history; start a new conversion if you want a fresh schema. Review shows the analysis mode, table row counts, warnings, and applicable line-item/total checks. These checks describe the original extraction, not subsequent manual edits.
9. **Appearance:** use **Dark mode / Light mode** in the top-right corner. Your choice is saved in the local SQLite settings and travels with the data folder. The first launch follows your system theme until you choose a mode. Dialogs, review fields, teaching controls, source text, and native dialogs use the selected appearance.

## Teaching and flagging fields during review

Open **Review** and highlight a value in **Extracted source text**, then click **Use selected text as example**. Alternatively, click **Teach a missing field** and type the example. Choose a new field name or select an existing field to fix. **Save field & draft** adds the column if necessary, saves the correction in SQLite, and updates the CSV while keeping the document in **Needs review**. Other edits in the review form are saved with it. An empty example adds a persistent missed-field flag.

To reuse a field on later documents, enter the literal source label immediately beside or above its value, such as `Purchase Order #`, and click **Check source label**. The helper can suggest a label from the selected example. A rule can be saved only if exactly one source match agrees with that example. Check **Reuse this source label on later documents** before saving. Only the label and its position beside or above a value are stored in the project schema; the example is never copied into other documents. Future imports and explicit reanalysis use the saved rule in either analysis mode. Reuse is scoped to the current project or quick conversion. It does not automatically rewrite older documents or other projects.

Reusable rules cover one value beside or below a label. Arbitrary page regions, repeating table-column mappings, and semantic inference from unlabeled examples are not supported by this helper. Those examples can still be saved as corrections for this document. If a saved label is absent or ambiguous in a later document, its field stays blank and an analysis warning explains why. Suggested matches remain subject to review. To change or stop reusing a label, open **Teach / fix** for that field, change its label rule or uncheck reuse, and save.

Each field also has **Flag as missed / incorrect**. The flag is stored immediately, appears on the document in the list, survives restart and reanalysis, and prevents marking the document reviewed until the value is corrected or the flag is explicitly cleared. **Save draft** stores unfinished edits and updates the CSV without marking reviewed or triggering removal retention. **Save & mark reviewed** completes the review; retention cleanup happens only after successful CSV export. Source selection uses extracted text, rather than clickable boxes on a rendered PDF.

When upgrading, close Portal and keep its **LiteParse Portal Data** folder. SQLite migrates automatically. Existing analysis settings are preserved; projects created before 0.2.0 keep **Standard** until changed. Since older versions did not record which reviewed values were corrections, migration protects all nonempty reviewed values; release any field with **Allow automatic extraction** if it should be refreshed. Back up the data folder and externally chosen CSVs before upgrading; older app versions cannot open the migrated database.

## Extraction scope

PDF, PNG, JPEG, TIFF, BMP, and WebP inputs are accepted. English OCR is included for scanned documents. Microsoft Office and OpenDocument conversion are excluded because upstream requires a separately installed LibreOffice for those formats.

Field discovery runs locally using deterministic text and layout rules, without an LLM or cloud API. Labels such as `Invoice #: 123`, `Supplier: Acme`, or `Department    Research` become fields. High accuracy additionally recognizes common invoice headings, identifiers, seller and billing blocks, and line-item columns. The schema still grows from detected fields rather than requiring a predefined list. These rules do not reliably infer the meaning of arbitrary prose or every invoice and table layout. Those documents need review and manually added fields. Unidentified table headers and applicable total mismatches are flagged for review. Text and OCR quality depend on the source; no universal semantic extraction or confidence score is claimed.

Limits in this version: 100 MiB per input, 2,000 pages per document, 50 MiB extracted text per document, 250 fields per project, 1,000,000 characters per reviewed field. Review previews show the first 200,000 characters. The document list is paginated with 100 entries per page and filters apply across the entire project; CSV export includes all completed entries. Parsing uses one isolated worker at a time, with a two-minute hard timeout for Standard and ten minutes for High accuracy, so a stuck or crashed parser cannot permanently block the queue.

## Data and portability

SQLite is embedded in the bundled desktop runtime through `node:sqlite`; there is no database service or external runtime. The data folder contains `portal.sqlite`, `sources/`, and `exports/`. SQLite uses disk-backed transactions, full synchronous commits, foreign-key checks, and content clearing on deletion. CSV writes use a temporary file followed by atomic replacement. Completed jobs, corrections, projects, schemas, and the queue persist across launches. Interrupted jobs return to the queue on restart. Duplicate file content is skipped within each project or quick conversion; the same file can belong to different projects.

Packaged applications prefer a **LiteParse Portal Data** folder beside the executable (beside the original download for the Windows portable EXE and Linux AppImage launchers). If no existing portable database is present and that location is not writable, the app uses the current user's application-data directory. The actual path is visible through **Open data folder**. An existing unreadable portable database causes an error instead of silently starting over. Development uses `.portal-data/`.

For an explicit data location:

```text
"LiteParse Portal.exe" --data-dir="D:\My document workspace"
./liteparse-portal --data-dir=/home/me/documents/portal-data
```

Close Portal before backing up or moving the entire data folder. Managed source and CSV paths are relocated automatically when that folder moves. Back up externally chosen CSVs too, especially with removal retention; external output and watched-folder paths remain configured to their original locations. Use one process on one machine per data folder; network shares and concurrent writers are not supported. Original input files are not changed or deleted. Watchers only run while the window is open. Closing stops the worker, saves the queue, and exits; it does not install a background service.

The database stays on disk as projects grow; it is not loaded wholesale into memory. CSV generation still materializes the exported fields, so very large CSVs can require substantial memory. Retention can keep source storage smaller.

## Building from source (developers only)

Build-time tools are separate from the delivered application. Use Node.js 24 and npm. Internet access is needed to obtain npm packages, Electron, and the pinned English OCR asset. End users do not perform these steps.

```sh
npm ci
node node_modules/electron/install.js
npm run prepare:assets
npm test
npm start
```

```sh
npm run dist:win     # Windows portable EXE + ZIP (build on Windows)
npm run dist:linux   # Linux AppImage + tar.gz (build on Linux)
npm run dist:appimage # Linux AppImage only
npm run dist:mac     # future macOS ZIP target; not release-validated
```

Windows release preparation also collects the Microsoft C++ runtime DLLs into the application folder. The native LiteParse Windows addon imports these DLLs; omitting them would incorrectly require users to install a redistributable. `scripts/prepare-windows-runtime.cjs` downloads a pinned Microsoft redistributable, verifies its SHA-256, and extracts the application-local x64 DLLs and license without running its installer. This is a build-time download only. The runtime DLLs ship beside the executable.

`npm run pack` produces an unpacked application for the current platform. `npm run smoke:packaged` exercises the actual packaged app, including renderer IPC, native PDF parsing, field expansion, review, and image OCR. `npm run smoke:appimage` runs those checks through the actual AppImage launcher and verifies that the database lives beside it, including a download path containing spaces. Set `PORTAL_TEST_APPIMAGE_EXTRACT=1` to exercise extraction mode without FUSE. On headless Linux prefix these commands with `xvfb-run -a`. For a restricted CI container only, `PORTAL_TEST_NO_SANDBOX=1` disables Chromium's OS sandbox for this test run; distributed launchers do not disable it.

The CI workflow builds Windows and Linux packages on their own operating systems, runs the tests and packaged smoke checks, and uploads artifacts. Windows-on-Linux builds are not a substitute for Windows validation. macOS packaging, signing, and notarization remain future work. Current local artifacts are unsigned; publisher signing is a release concern and does not change the normal-user runtime design.

## Verification status

See `VALIDATION.md` for checks actually performed in this workspace and outstanding target-machine checks. CI configuration is not evidence that CI has executed.
