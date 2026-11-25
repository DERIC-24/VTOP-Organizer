import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
    cleanVtopFilename,
    getFileExtension,
    parseContentDisposition
} from "../utils/filename-parser.js";
import {
    buildCourseFolderName,
    buildTargetFolderSegments,
    resolveUniqueFilename,
    sanitizePathSegment
} from "../utils/folder-organizer.js";
import {
    buildFormBody,
    DownloadError,
    downloadMaterial,
    validateDownloadedBinary
} from "../services/download-service.js";
import {
    buildValidSamplePdfBytes,
    createStage2TestFile,
    loadDirectoryHandle,
    pickAndSaveDirectory,
    requestDirectoryPermission,
    verifyDirectoryPermission,
    writeBinaryFile
} from "../services/file-system.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

test("manifest.json follows Stage 2 MV3 constraints", () => {
    const manifestPath = path.join(ROOT_DIR, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ["sidePanel", "storage", "scripting"]);
    assert.deepEqual(manifest.host_permissions, ["https://vtop.vit.ac.in/*"]);
    assert.ok(!manifest.permissions.includes("activeTab"));
    assert.ok(!manifest.permissions.includes("declarativeNetRequest"));
    assert.equal(manifest.background?.service_worker, "background/service-worker.js");
    assert.equal(manifest.side_panel?.default_path, "sidepanel/sidepanel.html");

    assert.equal(manifest.content_scripts.length, 2);
    assert.equal(manifest.content_scripts[0].world, "MAIN");
    assert.deepEqual(manifest.content_scripts[0].js, ["content/main-bridge.js"]);
    assert.deepEqual(manifest.content_scripts[1].js, [
        "content/course-parser.js",
        "content/vtop-detector.js"
    ]);
});

test("filename-parser extracts Content-Disposition and preserves non-PDF extensions", () => {
    assert.equal(
        parseContentDisposition(
            'attachment; filename="FALLSEM2026-27_VL_BAECE202_00100_TH_2026-11-10_RG1.pptx"'
        ),
        "FALLSEM2026-27_VL_BAECE202_00100_TH_2026-11-10_RG1.pptx"
    );
    assert.equal(
        parseContentDisposition("attachment; filename*=UTF-8''Notes%20Unit%201.pdf"),
        "Notes Unit 1.pdf"
    );
    assert.equal(
        parseContentDisposition('attachment; filename="../../evil/secret.pdf"'),
        "secret.pdf"
    );
    assert.equal(parseContentDisposition(""), null);

    assert.equal(
        cleanVtopFilename("FALLSEM2026-27_VL_BAECE202_00100_TH_2026-11-10_PWG1.pdf"),
        "PWG1.pdf"
    );
    assert.equal(
        cleanVtopFilename("FALLSEM2026-27_VL_BAECE202_00100_TH_2026-11-10_RG1.pptx"),
        "RG1.pptx"
    );
    assert.equal(getFileExtension("RG1.PPTX"), ".pptx");
});

test("folder-organizer sanitizes OS paths and resolves duplicate filenames", () => {
    assert.equal(sanitizePathSegment('Dr. A:B/C*?"<>|  .'), "Dr. A_B_C______");
    assert.equal(sanitizePathSegment("CON"), "CON_");
    assert.equal(
        buildCourseFolderName({
            courseCode: "BAECE202",
            courseName: "Engineering Electromagnetics"
        }),
        "BAECE202 - Engineering Electromagnetics"
    );
    assert.deepEqual(
        buildTargetFolderSegments({
            course: { courseCode: "BAECE202", courseName: "Engineering Electromagnetics" },
            uploadedBy: "FACULTY ONE",
            organizeByFaculty: true
        }),
        ["BAECE202 - Engineering Electromagnetics", "FACULTY ONE"]
    );

    const existing = new Set(["rg1.pptx", "rg1 (1).pptx"]);
    assert.equal(resolveUniqueFilename("RG1.pptx", existing), "RG1 (2).pptx");
});

test("download-service preserves duplicate _csrf fields and validates PDF, PPTX, HTML, and 404 responses", async () => {
    const formEntries = [
        ["_csrf", "token-a"],
        ["_csrf", "token-a"],
        ["authorizedID", "STUDENT01"],
        ["fileId", "stale-id"]
    ];
    const body = buildFormBody(formEntries, "9999000001");
    assert.deepEqual(body.getAll("_csrf"), ["token-a", "token-a"]);
    assert.equal(body.get("authorizedID"), "STUDENT01");
    assert.equal(body.get("fileId"), "9999000001");

    const pdfBuf = new TextEncoder().encode("%PDF-1.4 sample").buffer;
    const validPdf = validateDownloadedBinary({
        status: 200,
        ok: true,
        redirected: false,
        contentType: "application/pdf",
        contentDisposition: 'attachment; filename="FALLSEM2026-27_VL_BAECE202_00100_TH_2026-11-10_PWG1.pdf"',
        buffer: pdfBuf
    });
    assert.equal(validPdf.extension, ".pdf");

    const pptxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]).buffer;
    const validPptx = validateDownloadedBinary({
        status: 200,
        ok: true,
        redirected: false,
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        contentDisposition: 'attachment; filename="FALLSEM2026-27_VL_BAECE202_00100_TH_2026-11-10_RG1.pptx"',
        buffer: pptxBytes
    });
    assert.equal(validPptx.extension, ".pptx");

    const htmlBuf = new TextEncoder().encode("<!DOCTYPE html><html><body>Login</body></html>").buffer;
    assert.throws(
        () =>
            validateDownloadedBinary({
                status: 200,
                ok: true,
                redirected: false,
                contentType: "text/html;charset=utf-8",
                contentDisposition: "",
                buffer: htmlBuf
            }),
        (err) => err instanceof DownloadError && err.code === "SESSION_EXPIRED"
    );

    const fakePdfBuf = new TextEncoder().encode("NOT_A_PDF").buffer;
    assert.throws(
        () =>
            validateDownloadedBinary({
                status: 200,
                ok: true,
                redirected: false,
                contentType: "application/pdf",
                contentDisposition: 'attachment; filename="broken.pdf"',
                buffer: fakePdfBuf
            }),
        (err) => err instanceof DownloadError && err.code === "INVALID_PDF"
    );

    const originalFetch = globalThis.fetch;
    let capturedRequest = null;
    globalThis.fetch = async (url, init) => {
        capturedRequest = { url, init };
        return new Response(pptxBytes, {
            status: 200,
            headers: {
                "content-type":
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "content-disposition":
                    'attachment; filename="FALLSEM2026-27_VL_BAECE202_00100_TH_2026-11-10_RG1.pptx"'
            }
        });
    };

    try {
        const downloaded = await downloadMaterial({
            formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
            formEntries,
            fileId: "9999000001"
        });
        assert.equal(capturedRequest.init.method, "POST");
        assert.equal(capturedRequest.init.credentials, "include");
        assert.equal(downloaded.cleanFilename, "RG1.pptx");
        assert.equal(downloaded.byteLength, 6);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

function createMockBrowserEnv({
    rowsTotal = 100,
    domVisible = 10,
    dtInitialized = true,
    hasDtWrapper = true,
    allowPaginationControls = true
} = {}) {
    const listeners = { message: [] };
    const runtimeMessageListeners = [];

    let pageSize = domVisible;
    let currentPage = 0;

    const makeTr = (idx) => {
        const id = `202604${String(1000 + idx).padStart(4, "0")}`;
        const cells = [
            { innerText: String(idx + 1) },
            { innerText: "Fall Semester 2026-27\nBAECE202 - Engineering Electromagnetics - TH" },
            { innerText: `Topic ${idx + 1}\n5  (Document)` },
            { innerText: idx % 2 === 0 ? "10001 - FACULTY ONE - SENSE\n10-11-2026" : "10002 - FACULTY TWO - SCOPE\n11-11-2026" },
            { innerText: "" }
        ];
        return {
            cells,
            textContent: cells.map((c) => c.innerText).join(" "),
            querySelector: (sel) => {
                if (sel === ".dataTables_empty") return null;
                if (sel === "[data-fileid]") {
                    return { getAttribute: (attr) => (attr === "data-fileid" ? id : null) };
                }
                return null;
            }
        };
    };

    const allRows = Array.from({ length: rowsTotal }, (_, i) => makeTr(i));
    const getVisibleRows = () => {
        const start = currentPage * pageSize;
        return allRows.slice(start, start + pageSize);
    };

    const headers = [
        { innerText: "#" },
        { innerText: "Course Detail" },
        { innerText: "Material Detail" },
        { innerText: "Uploaded By" },
        { innerText: "Download" }
    ];

    const materialTable = {
        id: "materialTable",
        closest: (sel) => (sel === ".dataTables_wrapper" && hasDtWrapper ? {} : null),
        querySelector: (sel) => (sel === "tbody tr" ? getVisibleRows()[0] || null : null),
        querySelectorAll: (sel) => {
            if (sel === "tbody tr") return getVisibleRows();
            if (sel === "thead tr") return [{ querySelectorAll: () => headers }];
            return [];
        }
    };

    const lengthSelect = {
        value: String(domVisible),
        options: [
            { value: "10" },
            { value: "25" },
            { value: "50" },
            { value: "100" }
        ],
        dispatchEvent: (evt) => {
            if (evt.type === "change" && allowPaginationControls) {
                pageSize = Number.parseInt(lengthSelect.value, 10) || 10;
                currentPage = 0;
            }
        }
    };

    const nextContainer = {
        classList: {
            contains: (cls) => {
                if (cls !== "disabled") return false;
                if (!allowPaginationControls) return true;
                return (currentPage + 1) * pageSize >= allRows.length;
            }
        },
        querySelector: () => ({
            click: () => {
                if (allowPaginationControls && (currentPage + 1) * pageSize < allRows.length) {
                    currentPage += 1;
                }
            }
        })
    };

    const makePageButton = (pageNumText) => ({
        textContent: pageNumText,
        closest: (sel) =>
            sel.includes("active") && Number.parseInt(pageNumText, 10) - 1 === currentPage ? {} : null,
        click: () => {
            if (allowPaginationControls) {
                currentPage = Number.parseInt(pageNumText, 10) - 1;
            }
        }
    });

    const paginateEl = {
        querySelector: () => makePageButton(String(currentPage + 1)),
        querySelectorAll: () => [makePageButton("1"), makePageButton("2")]
    };

    const infoEl = {
        textContent: `Showing 1 to ${domVisible} of ${rowsTotal} entries`
    };

    const courseIdSelect = {
        selectedOptions: [
            {
                textContent:
                    "Fall Semester 2026-27 - BAECE202 - Engineering Electromagnetics - TH - Theory Only - 4.0"
            }
        ]
    };

    const formInputs = [
        { getAttribute: () => "_csrf", value: "csrf-sample-1" },
        { getAttribute: () => "_csrf", value: "csrf-sample-1" },
        { getAttribute: () => "authorizedID", value: "TESTUSER1" },
        { getAttribute: () => "fileId", value: "" }
    ];

    const downloadForm = {
        getAttribute: (name) =>
            name === "action" ? "/vtop/downloadCourseMaterialFacultyPdf" : "post",
        querySelectorAll: (sel) => (sel === "input[name]" ? formInputs : [])
    };

    const documentMock = {
        body: { querySelectorAll: () => [] },
        getElementById: (id) => {
            if (id === "materialTable") return materialTable;
            if (id === "courseMaterialstudentfileDown") return downloadForm;
            if (id === "courseId") return courseIdSelect;
            if (id === "materialTable_paginate") return hasDtWrapper ? paginateEl : null;
            if (id === "materialTable_next") return hasDtWrapper ? nextContainer : null;
            if (id === "materialTable_info") return hasDtWrapper ? infoEl : null;
            return null;
        },
        querySelector: (sel) => {
            if (sel === 'select[name="materialTable_length"]' && hasDtWrapper) {
                return lengthSelect;
            }
            return null;
        },
        querySelectorAll: () => []
    };

    const windowMock = {
        location: {
            origin: "https://vtop.vit.ac.in",
            hostname: "vtop.vit.ac.in",
            pathname: "/vtop/content",
            href: "https://vtop.vit.ac.in/vtop/content"
        },
        addEventListener: (type, fn) => {
            if (type === "message") listeners.message.push(fn);
        },
        removeEventListener: (type, fn) => {
            if (type === "message") {
                listeners.message = listeners.message.filter((f) => f !== fn);
            }
        },
        postMessage: (data, targetOrigin) => {
            queueMicrotask(() => {
                const snapshot = [...listeners.message];
                for (const fn of snapshot) {
                    fn({
                        source: windowMock,
                        origin: targetOrigin,
                        data
                    });
                }
            });
        },
        jQuery: Object.assign(
            () => ({
                DataTable: () => ({
                    rows: () => ({
                        nodes: () => ({
                            toArray: () => allRows
                        })
                    })
                })
            }),
            {
                fn: {
                    DataTable: {
                        isDataTable: (el) => el === materialTable && dtInitialized
                    }
                }
            }
        )
    };

    const chromeMock = {
        runtime: {
            id: "ext-id-stage2",
            onMessage: {
                addListener: (fn) => runtimeMessageListeners.push(fn),
                removeListener: (fn) => {
                    const idx = runtimeMessageListeners.indexOf(fn);
                    if (idx >= 0) runtimeMessageListeners.splice(idx, 1);
                }
            }
        }
    };

    const sharedGlobal = {
        window: windowMock,
        document: documentMock,
        chrome: chromeMock,
        URL,
        Event: class MockEvent {
            constructor(type, init = {}) {
                this.type = type;
                this.bubbles = Boolean(init.bubbles);
            }
        },
        crypto,
        setTimeout,
        clearTimeout,
        console
    };
    sharedGlobal.globalThis = sharedGlobal;

    return { sharedGlobal, listeners, runtimeMessageListeners, lengthSelect, getCurrentPage: () => currentPage };
}

function runBridgeScripts(sharedGlobal) {
    const context = vm.createContext(sharedGlobal);
    vm.runInContext(fs.readFileSync(path.join(ROOT_DIR, "content", "main-bridge.js"), "utf8"), context);
    vm.runInContext(fs.readFileSync(path.join(ROOT_DIR, "content", "course-parser.js"), "utf8"), context);
    vm.runInContext(fs.readFileSync(path.join(ROOT_DIR, "content", "vtop-detector.js"), "utf8"), context);
}

test("MAIN-world bridge + ISOLATED parser extract all 100 VTOP rows, course name, faculty, and dates", async () => {
    const { sharedGlobal, runtimeMessageListeners } = createMockBrowserEnv({
        rowsTotal: 100,
        domVisible: 10,
        dtInitialized: true
    });
    runBridgeScripts(sharedGlobal);

    const listener = runtimeMessageListeners[0];
    let rejectedResponseCalled = false;
    const acceptedForeign = listener(
        { type: "GET_VTOP_PAGE_STATE" },
        { id: "foreign-extension" },
        () => {
            rejectedResponseCalled = true;
        }
    );
    assert.equal(acceptedForeign, false);
    assert.equal(rejectedResponseCalled, false);

    const extraction = await new Promise((resolve) => {
        listener({ type: "EXTRACT_COURSE_MATERIALS" }, { id: "ext-id-stage2" }, resolve);
    });

    assert.equal(extraction.ok, true);
    assert.equal(extraction.stats.extractionMode, "datatables-api");
    assert.equal(extraction.course.courseCode, "BAECE202");
    assert.equal(extraction.course.courseName, "Engineering Electromagnetics");
    assert.equal(extraction.formAction, "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf");
    assert.equal(extraction.formEntries.length, 3);
    assert.equal(extraction.stats.domRowCount, 10);
    assert.equal(extraction.stats.totalRows, 100);
    assert.equal(extraction.stats.validFileIds, 100);
    assert.equal(extraction.materials[0].topic, "Topic 1");
    assert.equal(extraction.materials[0].uploadedBy, "FACULTY ONE");
    assert.equal(extraction.materials[0].uploadedDate, "10-11-2026");
    assert.equal(extraction.materials[99].fileId, "2026041099");
});

test("Pagination-sweep fallback extracts all 135 rows when DataTables registry was reset (isDataTable === false)", async () => {
    const { sharedGlobal, runtimeMessageListeners, lengthSelect, getCurrentPage } = createMockBrowserEnv({
        rowsTotal: 135,
        domVisible: 10,
        dtInitialized: false,
        hasDtWrapper: true,
        allowPaginationControls: true
    });
    runBridgeScripts(sharedGlobal);

    const extraction = await new Promise((resolve) => {
        runtimeMessageListeners[0](
            { type: "EXTRACT_COURSE_MATERIALS" },
            { id: "ext-id-stage2" },
            resolve
        );
    });

    assert.equal(extraction.ok, true);
    assert.equal(extraction.stats.extractionMode, "pagination-sweep");
    assert.equal(extraction.stats.domRowCount, 10);
    assert.equal(extraction.stats.totalRows, 135);
    assert.equal(extraction.stats.validFileIds, 135);
    assert.equal(extraction.materials[134].fileId, "2026041134");
    // Original UI pagination state restored
    assert.equal(lengthSelect.value, "10");
    assert.equal(getCurrentPage(), 0);
});

test("Refuses silent incomplete DOM extraction if pagination controls fail to reach expected entry count", async () => {
    const { sharedGlobal, runtimeMessageListeners } = createMockBrowserEnv({
        rowsTotal: 100,
        domVisible: 10,
        dtInitialized: false,
        hasDtWrapper: true,
        allowPaginationControls: false
    });
    runBridgeScripts(sharedGlobal);

    const extraction = await new Promise((resolve) => {
        runtimeMessageListeners[0](
            { type: "EXTRACT_COURSE_MATERIALS" },
            { id: "ext-id-stage2" },
            resolve
        );
    });

    assert.equal(extraction.ok, false);
    assert.equal(extraction.code, "INCOMPLETE_PAGINATION_EXTRACTION");
});

test("Re-injecting bridge scripts replaces old listeners cleanly without duplicates", async () => {
    const { sharedGlobal, listeners, runtimeMessageListeners } = createMockBrowserEnv({
        rowsTotal: 100,
        domVisible: 10,
        dtInitialized: false,
        hasDtWrapper: true
    });
    runBridgeScripts(sharedGlobal);
    runBridgeScripts(sharedGlobal);

    assert.equal(runtimeMessageListeners.length, 1);
    assert.equal(listeners.message.length, 1);

    const extraction = await new Promise((resolve) => {
        runtimeMessageListeners[0](
            { type: "EXTRACT_COURSE_MATERIALS" },
            { id: "ext-id-stage2" },
            resolve
        );
    });
    assert.equal(extraction.ok, true);
    assert.equal(extraction.stats.totalRows, 100);
});

test("file-system service persists directory handles in IndexedDB and writes non-overwriting test files", async () => {
    const stores = new Map();
    globalThis.indexedDB = {
        open: () => {
            const req = {};
            queueMicrotask(() => {
                const db = {
                    objectStoreNames: { contains: (name) => stores.has(name) },
                    createObjectStore: (name) => stores.set(name, new Map()),
                    transaction: (name) => {
                        const tx = {
                            objectStore: () => ({
                                put: (val, key) => {
                                    stores.get(name).set(key, val);
                                    queueMicrotask(() => tx.oncomplete?.());
                                },
                                get: (key) => {
                                    const getReq = {};
                                    queueMicrotask(() => {
                                        getReq.result = stores.get(name).get(key);
                                        getReq.onsuccess?.();
                                    });
                                    return getReq;
                                },
                                delete: (key) => {
                                    stores.get(name).delete(key);
                                    queueMicrotask(() => tx.oncomplete?.());
                                }
                            })
                        };
                        return tx;
                    },
                    close: () => {}
                };
                req.result = db;
                req.onupgradeneeded?.();
                req.onsuccess?.();
            });
            return req;
        }
    };

    function createMockDirHandle(name) {
        const subdirs = new Map();
        const files = new Map();
        let perm = "granted";

        return {
            name,
            _setPermission: (next) => {
                perm = next;
            },
            queryPermission: async () => perm,
            requestPermission: async () => {
                perm = "granted";
                return perm;
            },
            getDirectoryHandle: async (subName, { create } = {}) => {
                if (!subdirs.has(subName)) {
                    if (!create) throw new Error("NotFoundError");
                    subdirs.set(subName, createMockDirHandle(subName));
                }
                return subdirs.get(subName);
            },
            keys: async function* () {
                for (const key of files.keys()) {
                    yield key;
                }
            },
            getFileHandle: async (fileName) => {
                let bytes = files.get(fileName) || new Uint8Array(0);
                return {
                    createWritable: async () => ({
                        write: async (data) => {
                            bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                            files.set(fileName, bytes);
                        },
                        close: async () => {},
                        abort: async () => {}
                    }),
                    getFile: async () => ({
                        size: bytes.byteLength,
                        arrayBuffer: async () => bytes.slice().buffer
                    })
                };
            }
        };
    }

    const mockRoot = createMockDirHandle("Study Materials");
    globalThis.window = {
        showDirectoryPicker: async ({ mode }) => {
            assert.equal(mode, "readwrite");
            return mockRoot;
        }
    };

    const picked = await pickAndSaveDirectory();
    assert.equal(picked.handle.name, "Study Materials");
    assert.equal(picked.permission, "granted");

    mockRoot._setPermission("prompt");
    const restored = await loadDirectoryHandle();
    assert.equal(restored.name, "Study Materials");
    assert.equal(await verifyDirectoryPermission(restored), "prompt");
    assert.equal(await requestDirectoryPermission(restored), "granted");

    const first = await createStage2TestFile(restored);
    assert.equal(first.fileName, "stage2-fsa-test.pdf");
    assert.ok(first.size > 0);

    const second = await createStage2TestFile(restored);
    assert.equal(second.fileName, "stage2-fsa-test (1).pdf");

    const customDir = await restored.getDirectoryHandle("Custom", { create: true });
    const written = await writeBinaryFile(customDir, "RG1.pptx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    assert.equal(written.filename, "RG1.pptx");
    assert.equal(written.size, 4);

    // Verify the exact file written by createStage2TestFile() is structurally valid PDF
    const testSubdir = await restored.getDirectoryHandle("VTOP-Organizer-Test", { create: false });
    const testFileHandle = await testSubdir.getFileHandle("stage2-fsa-test.pdf");
    const writtenPdfBytes = new Uint8Array(await (await testFileHandle.getFile()).arrayBuffer());
    assert.deepEqual(writtenPdfBytes, buildValidSamplePdfBytes());
});

test("createStage2TestFile produces a spec-compliant PDF 1.4 parseable via xref and trailer", () => {
    const pdfBytes = buildValidSamplePdfBytes();
    const pdfText = Buffer.from(pdfBytes).toString("latin1");

    assert.ok(pdfText.startsWith("%PDF-1.4\n"));
    assert.ok(pdfText.trimEnd().endsWith("%%EOF"));

    const startxrefMatch = pdfText.match(/startxref\n(\d+)\n%%EOF\s*$/);
    assert.ok(startxrefMatch, "PDF must end with startxref <offset> %%EOF");
    const xrefOffset = Number.parseInt(startxrefMatch[1], 10);

    // Cross-reference table must begin exactly at xrefOffset
    assert.equal(pdfText.slice(xrefOffset, xrefOffset + 5), "xref\n");

    const xrefSection = pdfText.slice(xrefOffset);
    const xrefHeaderMatch = xrefSection.match(/^xref\n0 (\d+)\n/);
    assert.ok(xrefHeaderMatch, "xref subsection header '0 N' must exist");
    const objectCount = Number.parseInt(xrefHeaderMatch[1], 10);
    assert.equal(objectCount, 6);

    const entriesStart = xrefOffset + xrefHeaderMatch[0].length;
    const entries = [];
    for (let i = 0; i < objectCount; i += 1) {
        const entry = pdfText.slice(entriesStart + i * 20, entriesStart + (i + 1) * 20);
        assert.equal(entry.length, 20, `xref entry ${i} must be exactly 20 bytes`);
        const match = entry.match(/^(\d{10}) (\d{5}) ([fn]) \n$/);
        assert.ok(match, `xref entry ${i} invalid format: ${JSON.stringify(entry)}`);
        entries.push({
            offset: Number.parseInt(match[1], 10),
            generation: Number.parseInt(match[2], 10),
            inUse: match[3] === "n"
        });
    }

    assert.equal(entries[0].inUse, false);
    assert.equal(entries[0].generation, 65535);

    const parsedObjects = new Map();
    for (let objNum = 1; objNum < objectCount; objNum += 1) {
        assert.equal(entries[objNum].inUse, true);
        const objSlice = pdfText.slice(entries[objNum].offset);
        assert.ok(
            objSlice.startsWith(`${objNum} 0 obj\n`),
            `Object ${objNum} must begin at exact xref offset ${entries[objNum].offset}`
        );
        const endIdx = objSlice.indexOf("\nendobj\n");
        assert.ok(endIdx > 0, `Object ${objNum} must terminate with endobj`);
        parsedObjects.set(objNum, objSlice.slice(0, endIdx));
    }

    // Verify Trailer, Catalog, Pages, Page, Content Stream /Length, and Font
    const trailerMatch = xrefSection.match(/trailer\n<<\s*\/Size 6\s+\/Root 1 0 R\s*>>/);
    assert.ok(trailerMatch, "Trailer must declare /Size 6 and /Root 1 0 R");

    assert.match(parsedObjects.get(1), /\/Type\s+\/Catalog\b/);
    assert.match(parsedObjects.get(1), /\/Pages\s+2 0 R\b/);

    assert.match(parsedObjects.get(2), /\/Type\s+\/Pages\b/);
    assert.match(parsedObjects.get(2), /\/Kids\s+\[3 0 R\]/);
    assert.match(parsedObjects.get(2), /\/Count\s+1\b/);

    assert.match(parsedObjects.get(3), /\/Type\s+\/Page\b/);
    assert.match(parsedObjects.get(3), /\/Parent\s+2 0 R\b/);
    assert.match(parsedObjects.get(3), /\/MediaBox\s+\[0 0 612 792\]/);
    assert.match(parsedObjects.get(3), /\/Contents\s+4 0 R\b/);

    const obj4 = parsedObjects.get(4);
    const lengthMatch = obj4.match(/\/Length\s+(\d+)/);
    assert.ok(lengthMatch, "Content stream object 4 must specify /Length");
    const declaredLen = Number.parseInt(lengthMatch[1], 10);
    const streamStart = obj4.indexOf("stream\n") + "stream\n".length;
    const streamEnd = obj4.lastIndexOf("\nendstream");
    assert.ok(streamStart > 0 && streamEnd > streamStart);
    const actualStreamBytes = Buffer.byteLength(obj4.slice(streamStart, streamEnd), "latin1");
    assert.equal(actualStreamBytes, declaredLen);
    assert.ok(obj4.includes("VTOP Organizer - File System Access API Verified"));

    assert.match(parsedObjects.get(5), /\/Type\s+\/Font\b/);
    assert.match(parsedObjects.get(5), /\/Subtype\s+\/Type1\b/);
    assert.match(parsedObjects.get(5), /\/BaseFont\s+\/Helvetica\b/);
});

test(
    "Windows native PdfDocument reader loads and parses the generated PDF",
    { skip: process.platform !== "win32" },
    () => {
        const pdfBase64 = Buffer.from(buildValidSamplePdfBytes()).toString("base64");
        const psScript = [
            "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
            "[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null",
            "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
            "function Await-WinRT($op, $type) { $m = $asTask.MakeGenericMethod($type); $t = $m.Invoke($null, @($op)); $t.Wait(); return $t.Result }",
            "$b64 = [Console]::In.ReadToEnd().Trim()",
            "$bytes = [Convert]::FromBase64String($b64)",
            "$mem = New-Object System.IO.MemoryStream(,$bytes)",
            "$stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($mem)",
            "$pdf = Await-WinRT ([Windows.Data.Pdf.PdfDocument]::LoadFromStreamAsync($stream)) ([Windows.Data.Pdf.PdfDocument])",
            "$page = $pdf.GetPage(0)",
            'Write-Output ("PageCount={0};Width={1};Height={2};Protected={3}" -f $pdf.PageCount, $page.Size.Width, $page.Size.Height, $pdf.IsPasswordProtected)'
        ].join("; ");

        const output = execFileSync(
            "powershell",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
            { input: pdfBase64, encoding: "utf8" }
        ).trim();

        assert.equal(output, "PageCount=1;Width=816;Height=1056;Protected=False");
    }
);
