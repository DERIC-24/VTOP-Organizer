# VTOP Material Organizer

A Manifest V3 Chrome Extension for VIT Vellore's VTOP portal (`https://vtop.vit.ac.in/*`) that extracts course materials from Course Page Consolidated and saves them into a user-chosen local folder using the File System Access API.

**Current Status:** Stage 2 (Manifest V3 Foundation) completed and verified.

---

## Architecture Overview

- **Side Panel (`sidepanel/`):** Owns UI state, VTOP/course detection status, material list rendering, destination directory selection (`window.showDirectoryPicker({ mode: 'readwrite' })`), direct authenticated downloads, and local disk writes.
- **Content Scripts (`content/`):**
  - `main-bridge.js` (`MAIN` world): Reads `jQuery('#materialTable').DataTable().rows().nodes()` when initialized (`datatables-api` mode), with a live pagination-sweep fallback (`pagination-sweep` mode) when VTOP's AJAX navigation reloads `datatables.min.js` and clears `jQuery.fn.dataTable.settings`, plus plain DOM extraction when unpaginated.
  - `course-parser.js` (`ISOLATED` world): Extracts course code/title (`select#courseId` and `Course Detail` cells), reads `#courseMaterialstudentfileDown` form inputs directly from the DOM (preserving duplicate `_csrf` fields and `authorizedID` without exposing them over `window.postMessage`), and normalizes row metadata.
  - `vtop-detector.js` (`ISOLATED` world): Handles `GET_VTOP_PAGE_STATE` and `EXTRACT_COURSE_MATERIALS` messages from the extension runtime.
- **Services (`services/`):**
  - `download-service.js`: Executes authenticated `POST` requests directly from the Side Panel (`credentials: 'include'`), rejects HTML/session-expired responses, validates binary magic bytes (`%PDF` for `.pdf`, `PK` for OOXML/ZIP such as `.pptx`/`.docx`/`.xlsx`), and preserves original file extensions.
  - `file-system.js`: Persists `FileSystemDirectoryHandle` in IndexedDB (`vtop_organizer_fs`), handles permission verification/re-authorization, creates nested sanitized directories, prevents duplicate overwrites, and generates a spec-compliant PDF 1.4 verification file (`createStage2TestFile()`).
- **Utilities (`utils/`):**
  - `filename-parser.js`: Parses `Content-Disposition` (including RFC 5987 `filename*` and path-traversal stripping) and cleans VTOP timestamp/course prefixes while preserving extensions.
  - `folder-organizer.js`: Sanitizes OS path segments and resolves case-insensitive filename collisions.
- **Service Worker (`background/service-worker.js`):** Minimal MV3 lifecycle worker enabling Side Panel launch on action click.

### Permissions

- `permissions`: `["sidePanel", "storage", "scripting"]`
- `host_permissions`: `["https://vtop.vit.ac.in/*"]`
- Neither `activeTab` nor `declarativeNetRequest` is used.

---

## Repository Structure

```text
VTOP-Organizer/
├── manifest.json
├── README.md
├── background/
│   └── service-worker.js
├── content/
│   ├── main-bridge.js
│   ├── course-parser.js
│   └── vtop-detector.js
├── services/
│   ├── download-service.js
│   └── file-system.js
├── sidepanel/
│   ├── sidepanel.html
│   ├── sidepanel.css
│   └── sidepanel.js
├── utils/
│   ├── filename-parser.js
│   └── folder-organizer.js
└── tests/
    └── run-tests.mjs
```

---

## Development & Verification

### Automated Tests (Zero Dependencies)

Requires Node.js (tested on `v24.20.0`):

```powershell
node --test tests/run-tests.mjs
```

### Loading as an Unpacked Extension in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repository folder.
3. Log in to VTOP (`https://vtop.vit.ac.in`) and open **Course Page Consolidated**.
4. Click the **VTOP Organizer** toolbar icon to open the Side Panel, scan course materials, and choose a destination folder.

### Stage 2 Verification Summary

- **Automated suite (`node --test tests/run-tests.mjs`):** 11/11 tests passing (MV3 manifest constraints, filename/folder utilities, download validation & duplicate `_csrf` handling, `MAIN`/`ISOLATED` bridge extraction for 100-row API and 135-row pagination sweep, incomplete-extraction guard, re-injection listener cleanup, IndexedDB/FSA persistence, byte-level PDF 1.4 xref/trailer parser, and Windows `Windows.Data.Pdf.PdfDocument` reader check).
- **Syntax check (`node --check`):** 10/10 `.js`/`.mjs` files passing.
- **Live Chrome `158.0.8127.37` + VTOP integration checks:** Confirmed Side Panel VTOP/course detection, 101-record extraction, File System Access API folder persistence and readable PDF test file write, and live single-material authenticated `POST` download + disk write of a real `.pptx` course file (`1,437,314` bytes).
