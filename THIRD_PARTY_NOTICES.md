# Third-party components

LiteParse Portal uses these open-source components. Preserve this file, the application license, dependency notices, and the Electron notices when redistributing the application.

| Component | License / source |
| --- | --- |
| LiteParse 2.15.1, including native bindings | Apache-2.0; https://github.com/run-llama/liteparse |
| SQLite (embedded in Node.js / Electron) | Public domain; https://sqlite.org/copyright.html; bundled runtime notices also cover the Node.js integration |
| csv-parse | MIT; https://github.com/adaltas/node-csv |
| Electron / Chromium / Node.js | MIT and bundled dependency notices; the distribution contains `LICENSE`, `LICENSES.chromium.html`, and Electron license resources |
| PDFium | BSD-style notices and third-party licenses; https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE and https://github.com/bblanchon/pdfium-binaries |
| Tesseract / Leptonica (linked by LiteParse) | Apache-2.0 / BSD-style; https://github.com/tesseract-ocr/tesseract and https://github.com/DanBloomberg/leptonica |
| English Tesseract model (`tessdata_best`) | Apache-2.0; pinned source https://github.com/tesseract-ocr/tessdata_best/tree/e12c65a915945e4c28e237a9b52bc4a8f39a0cec |
| Microsoft Visual C++ runtime (Windows builds only) | Microsoft redistributable license; DLLs and `LICENSE.rtf` are extracted from a pinned, SHA-256-verified Microsoft redistribution package. |

`scripts/collect-notices.cjs` gathers installed production-package license files and the pinned upstream parser/OCR/native notices into `assets/notices/`, which is shipped in the application's resources. Build tooling is not part of the application runtime. The upstream native distributions may include additional transitive code; native notices are gathered from the pinned upstream sources and PDFium's notice bundle. Distribution maintainers should review the resulting notice bundle when upgrading native components.
