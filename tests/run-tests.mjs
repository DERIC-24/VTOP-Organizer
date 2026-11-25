import test from "node:test";
import assert from "node:assert/strict";
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
    formatCourseTypeFolderSegment,
    resolveUniqueFilename,
    sanitizePathSegment
} from "../utils/folder-organizer.js";
import {
    buildAllDownloadPayload,
    buildSelectedDownloadPayload,
    countSelectedMaterials,
    deselectAllMaterials,
    prepareSelectableMaterials,
    selectAllMaterials,
    toggleMaterialSelection
} from "../utils/material-selection.js";
import {
    buildFormBody,
    buildProgressState,
    DownloadError,
    downloadMaterial,
    parseContentLength,
    validateDownloadedBinary
} from "../services/download-service.js";
import {
    ensureSubdirectory,
    loadDirectoryHandle,
    pickAndSaveDirectory,
    requestDirectoryPermission,
    verifyDirectoryPermission,
    writeBinaryFile
} from "../services/file-system.js";
import {
    canTransitionMaterialState,
    canTransitionQueueState,
    computeFinalQueueState,
    InvalidStateTransitionError,
    isTerminalMaterialState,
    isTerminalQueueState,
    MATERIAL_STATES,
    QUEUE_STATES,
    transitionMaterialState,
    transitionQueueState
} from "../services/download-state.js";
import {
    ABORT_REASONS,
    classifyDownloadError,
    createIntentionalAbortError,
    ERROR_CATEGORIES,
    MAX_DOWNLOAD_ATTEMPTS,
    sanitizeErrorMessage,
    shouldRetryAttempt
} from "../services/download-errors.js";
import {
    ALL_404_SESSION_WARNING,
    AUTH_EXPIRED_SESSION_WARNING,
    createFileSystemSaveAdapter,
    DownloadQueueManager,
    getAll404SessionWarning,
    getAuthExpiredWarning,
    ORGANIZATION_MODES,
    QUEUE_EVENTS
} from "../services/queue-manager.js";

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

test("file-system service persists directory handles in IndexedDB, creates nested subdirectories, and writes non-overwriting binary files", async () => {
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

    const nestedDir = await ensureSubdirectory(restored, [
        "BAECE203 - Analog Electronics",
        "ETH - Embedded Theory",
        "FACULTY ONE"
    ]);
    const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const first = await writeBinaryFile(nestedDir, "RG1.pptx", payload);
    assert.equal(first.filename, "RG1.pptx");
    assert.equal(first.size, 4);

    const second = await writeBinaryFile(nestedDir, "RG1.pptx", payload);
    assert.equal(second.filename, "RG1 (1).pptx");
    assert.equal(second.size, 4);

    const writtenHandle = await nestedDir.getFileHandle("RG1.pptx");
    const writtenBytes = new Uint8Array(await (await writtenHandle.getFile()).arrayBuffer());
    assert.deepEqual(writtenBytes, payload);
});

test("Stage 3A state machine enforces valid and invalid material/queue transitions", () => {
    // Valid material transitions
    assert.equal(transitionMaterialState(MATERIAL_STATES.PENDING, MATERIAL_STATES.DOWNLOADING), MATERIAL_STATES.DOWNLOADING);
    assert.equal(transitionMaterialState(MATERIAL_STATES.DOWNLOADING, MATERIAL_STATES.RETRYING), MATERIAL_STATES.RETRYING);
    assert.equal(transitionMaterialState(MATERIAL_STATES.RETRYING, MATERIAL_STATES.DOWNLOADING), MATERIAL_STATES.DOWNLOADING);
    assert.equal(transitionMaterialState(MATERIAL_STATES.DOWNLOADING, MATERIAL_STATES.COMPLETED), MATERIAL_STATES.COMPLETED);
    assert.equal(transitionMaterialState(MATERIAL_STATES.PENDING, MATERIAL_STATES.SKIPPED), MATERIAL_STATES.SKIPPED);

    // Terminal material states reject further transitions
    for (const terminal of [
        MATERIAL_STATES.COMPLETED,
        MATERIAL_STATES.FAILED,
        MATERIAL_STATES.CANCELLED,
        MATERIAL_STATES.SKIPPED
    ]) {
        assert.equal(isTerminalMaterialState(terminal), true);
        assert.equal(canTransitionMaterialState(terminal, MATERIAL_STATES.DOWNLOADING), false);
        assert.throws(
            () => transitionMaterialState(terminal, MATERIAL_STATES.PENDING),
            InvalidStateTransitionError
        );
    }

    // Invalid arbitrary material transition
    assert.throws(
        () => transitionMaterialState(MATERIAL_STATES.PENDING, MATERIAL_STATES.COMPLETED),
        InvalidStateTransitionError
    );

    // Valid queue transitions including reserved Stage 3C states
    assert.equal(transitionQueueState(QUEUE_STATES.IDLE, QUEUE_STATES.RUNNING), QUEUE_STATES.RUNNING);
    assert.equal(transitionQueueState(QUEUE_STATES.RUNNING, QUEUE_STATES.PAUSED), QUEUE_STATES.PAUSED);
    assert.equal(transitionQueueState(QUEUE_STATES.PAUSED, QUEUE_STATES.RUNNING), QUEUE_STATES.RUNNING);
    assert.equal(transitionQueueState(QUEUE_STATES.RUNNING, QUEUE_STATES.CANCELLING), QUEUE_STATES.CANCELLING);
    assert.equal(transitionQueueState(QUEUE_STATES.CANCELLING, QUEUE_STATES.COMPLETED_WITH_ERRORS), QUEUE_STATES.COMPLETED_WITH_ERRORS);

    // Terminal queue states
    assert.equal(isTerminalQueueState(QUEUE_STATES.COMPLETED), true);
    assert.equal(isTerminalQueueState(QUEUE_STATES.COMPLETED_WITH_ERRORS), true);
    assert.equal(canTransitionQueueState(QUEUE_STATES.COMPLETED, QUEUE_STATES.RUNNING), false);
    assert.throws(
        () => transitionQueueState(QUEUE_STATES.IDLE, QUEUE_STATES.COMPLETED),
        InvalidStateTransitionError
    );

    assert.equal(
        computeFinalQueueState([{ state: MATERIAL_STATES.COMPLETED }, { state: MATERIAL_STATES.SKIPPED }]),
        QUEUE_STATES.COMPLETED
    );
    assert.equal(
        computeFinalQueueState([{ state: MATERIAL_STATES.COMPLETED }, { state: MATERIAL_STATES.FAILED }]),
        QUEUE_STATES.COMPLETED_WITH_ERRORS
    );
});

test("Stage 3A error classifier distinguishes retryable, 404, 403, auth, binary, and filesystem failures", () => {
    const netErr = classifyDownloadError(new TypeError("Failed to fetch"));
    assert.equal(netErr.category, ERROR_CATEGORIES.NETWORK_ERROR);
    assert.equal(netErr.retryable, true);

    const serverErr = classifyDownloadError({ status: 503, message: "Service Unavailable" });
    assert.equal(serverErr.category, ERROR_CATEGORIES.SERVER_ERROR);
    assert.equal(serverErr.retryable, true);

    // 404 must remain individual NOT_FOUND, NOT auth_expired
    const notFoundErr = classifyDownloadError(new DownloadError("MATERIAL_NOT_FOUND", "Not found", 404));
    assert.equal(notFoundErr.category, ERROR_CATEGORIES.NOT_FOUND);
    assert.equal(notFoundErr.retryable, false);
    assert.notEqual(notFoundErr.category, ERROR_CATEGORIES.AUTH_EXPIRED);

    const forbiddenErr = classifyDownloadError(new DownloadError("SESSION_EXPIRED", "Forbidden", 403));
    assert.equal(forbiddenErr.category, ERROR_CATEGORIES.FORBIDDEN);
    assert.equal(forbiddenErr.retryable, false);

    const authErr = classifyDownloadError(new DownloadError("SESSION_EXPIRED", "VTOP session expired", 401));
    assert.equal(authErr.category, ERROR_CATEGORIES.AUTH_EXPIRED);
    assert.equal(authErr.retryable, false);

    const htmlErr = classifyDownloadError({ code: "INVALID_HTML", status: 200, message: "Unexpected HTML" });
    assert.equal(htmlErr.category, ERROR_CATEGORIES.INVALID_HTML);
    assert.equal(htmlErr.retryable, false);

    const binErr = classifyDownloadError(new DownloadError("INVALID_PDF", "Missing %PDF", 200));
    assert.equal(binErr.category, ERROR_CATEGORIES.INVALID_BINARY);
    assert.equal(binErr.retryable, false);

    const fsPermErr = classifyDownloadError({ name: "NotAllowedError", message: "Permission denied" }, { phase: "save" });
    assert.equal(fsPermErr.category, ERROR_CATEGORIES.FS_PERMISSION_ERROR);
    assert.equal(fsPermErr.retryable, false);

    const fsWriteErr = classifyDownloadError({ name: "QuotaExceededError", message: "Disk full" }, { phase: "save" });
    assert.equal(fsWriteErr.category, ERROR_CATEGORIES.FS_WRITE_ERROR);
    assert.equal(fsWriteErr.retryable, false);

    const unknownErr = classifyDownloadError(new Error("Unexpected glitch"));
    assert.equal(unknownErr.category, ERROR_CATEGORIES.UNKNOWN_ERROR);
    assert.equal(unknownErr.retryable, false);

    // Retry boundary (max 3 total attempts)
    assert.equal(MAX_DOWNLOAD_ATTEMPTS, 3);
    assert.equal(shouldRetryAttempt(netErr, 1), true);
    assert.equal(shouldRetryAttempt(netErr, 2), true);
    assert.equal(shouldRetryAttempt(netErr, 3), false);
    assert.equal(shouldRetryAttempt(notFoundErr, 1), false);
    assert.equal(shouldRetryAttempt(authErr, 1), false);
});

test("Stage 3A queue executes sequentially (max concurrency 1), saves before completion, and keeps order", async () => {
    const executionOrder = [];
    const events = [];
    let activeDownloads = 0;
    let maxObservedConcurrency = 0;
    let stateDuringSave = null;

    const manager = new DownloadQueueManager({
        delayFn: async () => {},
        onEvent: (evt) => events.push(evt),
        downloadMaterial: async ({ fileId, formEntries }) => {
            assert.deepEqual(formEntries[0], ["_csrf", "secret-csrf-token"]);
            activeDownloads += 1;
            maxObservedConcurrency = Math.max(maxObservedConcurrency, activeDownloads);
            executionOrder.push(`download:${fileId}`);
            await new Promise((r) => setTimeout(r, 5));
            activeDownloads -= 1;
            return {
                buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                rawFilename: `FALLSEM2026-27_VL_BAECE202_00100_TH_2026-11-10_${fileId}.pdf`,
                cleanFilename: `${fileId}.pdf`,
                contentType: "application/pdf",
                byteLength: 4
            };
        },
        saveMaterial: async ({ material, downloadResult, organizationMode, folderSegments }) => {
            // Item must still be in 'downloading' during saveMaterial (not yet 'completed')
            const snapDuringSave = manager.getSnapshot();
            const currentItem = snapDuringSave.items.find((i) => i.fileId === material.fileId);
            stateDuringSave = currentItem.state;

            executionOrder.push(`save:${material.fileId}:${organizationMode}`);
            assert.deepEqual(folderSegments, ["BAECE202 - Engineering Electromagnetics", "FACULTY ONE"]);
            return {
                filename: downloadResult.cleanFilename,
                size: downloadResult.byteLength,
                path: `Root/${folderSegments.join("/")}/${downloadResult.cleanFilename}`
            };
        }
    });

    const loadRes = manager.loadQueue(
        [
            { fileId: "9999000001", topic: "Module 1", uploadedBy: "FACULTY ONE" },
            { fileId: "9999000002", topic: "Module 2", uploadedBy: "FACULTY ONE" }
        ],
        {
            course: { courseCode: "BAECE202", courseName: "Engineering Electromagnetics" },
            organizationMode: ORGANIZATION_MODES.COURSE_FACULTY,
            formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
            formEntries: [["_csrf", "secret-csrf-token"], ["authorizedID", "STUDENT99"]]
        }
    );

    assert.equal(loadRes.ok, true);
    const result = await manager.start();
    assert.equal(result.ok, true);
    assert.equal(maxObservedConcurrency, 1);
    assert.equal(stateDuringSave, MATERIAL_STATES.DOWNLOADING);
    assert.deepEqual(executionOrder, [
        "download:9999000001",
        "save:9999000001:course_faculty",
        "download:9999000002",
        "save:9999000002:course_faculty"
    ]);
    assert.equal(result.snapshot.queueState, QUEUE_STATES.COMPLETED);
    assert.equal(result.snapshot.completed, 2);
    assert.equal(result.snapshot.failed, 0);

    // Ensure no auth secrets ever leak into snapshots or events
    const serialized = JSON.stringify({ snapshot: result.snapshot, events });
    assert.equal(serialized.includes("secret-csrf-token"), false);
    assert.equal(serialized.includes("STUDENT99"), false);

    // Deterministic event boundary check
    assert.equal(events[0].type, QUEUE_EVENTS.QUEUE_STARTED);
    assert.equal(events[events.length - 1].type, QUEUE_EVENTS.QUEUE_COMPLETED);
});

test("Stage 3A queue handles retries (max 3), non-retryable 404/auth/write failures, and continues remaining items", async () => {
    const attemptCounts = new Map();
    const events = [];

    const manager = new DownloadQueueManager({
        delayFn: async () => {},
        onEvent: (evt) => events.push(evt),
        downloadMaterial: async ({ fileId }) => {
            const count = (attemptCounts.get(fileId) || 0) + 1;
            attemptCounts.set(fileId, count);

            if (fileId === "RETRY_THEN_PASS") {
                if (count < 3) {
                    throw new TypeError("Failed to fetch");
                }
            } else if (fileId === "EXHAUST_RETRIES") {
                throw { status: 503, message: "Server busy" };
            } else if (fileId === "MISSING_404") {
                throw new DownloadError("MATERIAL_NOT_FOUND", "File missing", 404);
            } else if (fileId === "AUTH_401") {
                throw new DownloadError("SESSION_EXPIRED", "Session expired", 401);
            }

            return {
                buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                rawFilename: `${fileId}.pdf`,
                cleanFilename: `${fileId}.pdf`,
                contentType: "application/pdf",
                byteLength: 4
            };
        },
        saveMaterial: async ({ material, downloadResult }) => {
            if (material.fileId === "SAVE_FAIL") {
                const err = new Error("Permission revoked");
                err.name = "NotAllowedError";
                throw err;
            }
            return {
                filename: downloadResult.cleanFilename,
                size: downloadResult.byteLength,
                path: `Root/${downloadResult.cleanFilename}`
            };
        }
    });

    manager.loadQueue(
        [
            { fileId: "RETRY_THEN_PASS", topic: "Retry Succeeds" },
            { fileId: "EXHAUST_RETRIES", topic: "Server 503 Fails" },
            { fileId: "MISSING_404", topic: "Missing 404" },
            { fileId: "AUTH_401", topic: "Auth 401" },
            { fileId: "SAVE_FAIL", topic: "Write Fails" },
            { fileId: "FINAL_PASS", topic: "Final Item Continues" }
        ],
        {
            course: { courseCode: "BAECE202", courseName: "Engineering Electromagnetics" },
            organizationMode: ORGANIZATION_MODES.COURSE_ONLY,
            formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
            formEntries: [["_csrf", "t1"]]
        }
    );

    const { snapshot } = await manager.start();
    assert.equal(snapshot.queueState, QUEUE_STATES.COMPLETED_WITH_ERRORS);
    assert.equal(snapshot.total, 6);
    assert.equal(snapshot.completed, 2);
    assert.equal(snapshot.failed, 4);

    const byId = Object.fromEntries(snapshot.items.map((item) => [item.fileId, item]));
    assert.equal(byId.RETRY_THEN_PASS.state, MATERIAL_STATES.COMPLETED);
    assert.equal(byId.RETRY_THEN_PASS.attempts, 3);

    assert.equal(byId.EXHAUST_RETRIES.state, MATERIAL_STATES.FAILED);
    assert.equal(byId.EXHAUST_RETRIES.attempts, 3);
    assert.equal(byId.EXHAUST_RETRIES.error.category, ERROR_CATEGORIES.SERVER_ERROR);

    assert.equal(byId.MISSING_404.state, MATERIAL_STATES.FAILED);
    assert.equal(byId.MISSING_404.attempts, 1);
    assert.equal(byId.MISSING_404.error.category, ERROR_CATEGORIES.NOT_FOUND);

    assert.equal(byId.AUTH_401.state, MATERIAL_STATES.FAILED);
    assert.equal(byId.AUTH_401.attempts, 1);
    assert.equal(byId.AUTH_401.error.category, ERROR_CATEGORIES.AUTH_EXPIRED);

    assert.equal(byId.SAVE_FAIL.state, MATERIAL_STATES.FAILED);
    assert.equal(byId.SAVE_FAIL.attempts, 1);
    assert.equal(byId.SAVE_FAIL.error.category, ERROR_CATEGORIES.FS_PERMISSION_ERROR);

    // Individual failures must not stop final item
    assert.equal(byId.FINAL_PASS.state, MATERIAL_STATES.COMPLETED);
    assert.equal(byId.FINAL_PASS.attempts, 1);

    assert.equal(events[events.length - 1].type, QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS);
});

test("Stage 3A queue validates empty input, skips duplicates, blocks re-running completed items, and wires both folder modes", async () => {
    const downloadedIds = [];
    const seenModes = [];

    const manager = new DownloadQueueManager({
        delayFn: async () => {},
        downloadMaterial: async ({ fileId }) => {
            downloadedIds.push(fileId);
            return {
                buffer: new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
                rawFilename: `${fileId}.pptx`,
                cleanFilename: `${fileId}.pptx`,
                contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                byteLength: 4
            };
        },
        saveMaterial: async ({ organizationMode, folderSegments, downloadResult }) => {
            seenModes.push({ organizationMode, folderSegments });
            return {
                filename: downloadResult.cleanFilename,
                size: 4,
                path: `${folderSegments.join("/")}/${downloadResult.cleanFilename}`
            };
        }
    });

    // Empty queue rejected and stays idle
    const emptyRes = manager.loadQueue([]);
    assert.equal(emptyRes.ok, false);
    assert.equal(emptyRes.code, "EMPTY_QUEUE");
    assert.equal(manager.getSnapshot().queueState, QUEUE_STATES.IDLE);

    const startEmptyRes = await manager.start();
    assert.equal(startEmptyRes.ok, false);

    // Duplicate material identifier skipped without duplicate download; course_only mode verified
    const dupLoad = manager.loadQueue(
        [
            { fileId: "9999000010", topic: "Slide 1", uploadedBy: "FACULTY ONE" },
            { fileId: "9999000010", topic: "Slide 1 Duplicate", uploadedBy: "FACULTY ONE" }
        ],
        {
            course: { courseCode: "BAECE202", courseName: "Engineering Electromagnetics" },
            organizationMode: ORGANIZATION_MODES.COURSE_ONLY,
            formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
            formEntries: [["_csrf", "t1"]]
        }
    );
    assert.equal(dupLoad.ok, true);
    assert.equal(dupLoad.snapshot.pending, 1);
    assert.equal(dupLoad.snapshot.skipped, 1);

    const completedRun = await manager.start();
    assert.equal(completedRun.ok, true);
    assert.deepEqual(downloadedIds, ["9999000010"]);
    assert.deepEqual(seenModes, [
        {
            organizationMode: ORGANIZATION_MODES.COURSE_ONLY,
            folderSegments: ["BAECE202 - Engineering Electromagnetics"]
        }
    ]);
    assert.equal(completedRun.snapshot.completed, 1);
    assert.equal(completedRun.snapshot.skipped, 1);

    // Completed queue cannot be started again to re-download completed items
    const rerun = await manager.start();
    assert.equal(rerun.ok, false);
    assert.equal(rerun.code, "INVALID_QUEUE_STATE");
    assert.deepEqual(downloadedIds, ["9999000010"]);

    // Verify createFileSystemSaveAdapter handles missing faculty fallback cleanly in course_faculty mode
    const createdDirs = [];
    const adapter = createFileSystemSaveAdapter({
        getRootHandle: async () => ({ name: "RootDir" }),
        verifyDirectoryPermission: async () => "granted",
        ensureSubdirectory: async (root, segments) => {
            createdDirs.push(segments);
            return root;
        },
        writeBinaryFile: async (_dir, filename, data) => ({
            filename,
            size: data.byteLength
        })
    });

    const adapterResult = await adapter({
        material: {
            courseCode: "BAECE202",
            courseName: "Engineering Electromagnetics",
            facultyName: "",
            topic: "Notes"
        },
        downloadResult: {
            buffer: new Uint8Array([1, 2, 3]),
            cleanFilename: "Notes.pdf"
        },
        organizationMode: ORGANIZATION_MODES.COURSE_FACULTY
    });

    assert.deepEqual(createdDirs, [["BAECE202 - Engineering Electromagnetics", "Unknown Faculty"]]);
    assert.equal(adapterResult.path, "RootDir/BAECE202 - Engineering Electromagnetics/Unknown Faculty/Notes.pdf");
});

test("Stage 3A concurrent start(), loadQueue() guards, ineligible-only queue, and duplicate fileIds with distinct IDs", async () => {
    let activeDownloads = 0;
    let maxConcurrent = 0;
    const downloadedFileIds = [];

    const manager = new DownloadQueueManager({
        delayFn: async () => {},
        downloadMaterial: async ({ fileId }) => {
            activeDownloads += 1;
            maxConcurrent = Math.max(maxConcurrent, activeDownloads);
            downloadedFileIds.push(fileId);
            await new Promise((r) => setTimeout(r, 15));
            activeDownloads -= 1;
            return {
                buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                rawFilename: `${fileId}.pdf`,
                cleanFilename: `${fileId}.pdf`,
                contentType: "application/pdf",
                byteLength: 4
            };
        },
        saveMaterial: async ({ downloadResult }) => ({
            filename: downloadResult.cleanFilename,
            size: 4,
            path: `Root/${downloadResult.cleanFilename}`
        })
    });

    // Ineligible-only queue stays idle
    const ineligibleRes = manager.loadQueue([{ topic: "No File ID" }, { id: "row-2", fileId: "   " }]);
    assert.equal(ineligibleRes.ok, false);
    assert.equal(ineligibleRes.code, "NO_ELIGIBLE_MATERIALS");
    assert.equal(manager.getSnapshot().queueState, QUEUE_STATES.IDLE);

    // Invalid organizationMode rejected
    const badMode = manager.loadQueue([{ fileId: "F1" }], { organizationMode: "flat_invalid" });
    assert.equal(badMode.ok, false);
    assert.equal(badMode.code, "INVALID_ORGANIZATION_MODE");

    // Malformed formEntries rejected without throwing or exposing entries
    const badForm = manager.loadQueue([{ fileId: "F1" }], { formEntries: [["_csrf"]] });
    assert.equal(badForm.ok, false);
    assert.equal(badForm.code, "INVALID_FORM_ENTRIES");

    // Duplicate fileId with distinct id properties must skip duplicate and use skipReason (error === null)
    const loaded = manager.loadQueue(
        [
            { id: "row-1", fileId: "DUP_FILE_1", topic: "First" },
            { id: "row-2", fileId: "DUP_FILE_1", topic: "Second with same fileId" }
        ],
        {
            formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
            formEntries: [["_csrf", "tok"], ["authorizedID", "ID01"]]
        }
    );
    assert.equal(loaded.ok, true);
    assert.equal(loaded.snapshot.pending, 1);
    assert.equal(loaded.snapshot.skipped, 1);
    assert.equal(loaded.snapshot.items[1].error, null);
    assert.match(loaded.snapshot.items[1].skipReason, /Duplicate fileId/i);

    // Start queue concurrently and attempt loadQueue while running
    const p1 = manager.start();
    const p2 = manager.start();
    const midLoad = manager.loadQueue([{ fileId: "NEW_ITEM" }]);

    const [res1, res2] = await Promise.all([p1, p2]);
    assert.equal(res1.ok, true);
    assert.equal(res2.ok, false);
    assert.equal(res2.code, "INVALID_QUEUE_STATE");
    assert.equal(midLoad.ok, false);
    assert.equal(midLoad.code, "QUEUE_ALREADY_RUNNING");
    assert.equal(maxConcurrent, 1);
    assert.deepEqual(downloadedFileIds, ["DUP_FILE_1"]);
});

test("Stage 3A handles unexpected exceptions safely, isolates onEvent errors, and verifies retry delay bounds", async () => {
    const delayCalls = [];

    // 1. Retry delay invoked exactly twice on 3 failed attempts (never after attempt 3)
    const retryManager = new DownloadQueueManager({
        getRetryDelayMs: (attempt) => {
            delayCalls.push(attempt);
            return 10 * attempt;
        },
        delayFn: async (ms) => {
            delayCalls.push(`sleep:${ms}`);
        },
        downloadMaterial: async () => {
            throw { status: 503, message: "Temporary outage" };
        },
        saveMaterial: async () => ({ filename: "unused", size: 0, path: "unused" })
    });
    retryManager.loadQueue([{ fileId: "ALWAYS_503" }]);
    const retryRun = await retryManager.start();
    assert.equal(retryRun.snapshot.queueState, QUEUE_STATES.COMPLETED_WITH_ERRORS);
    assert.equal(retryRun.snapshot.items[0].attempts, 3);
    assert.deepEqual(delayCalls, [1, "sleep:10", 2, "sleep:20"]);

    // 2. Unexpected internal error (e.g., delayFn throwing) leaves queue in completed_with_errors, never stuck in running
    const crashManager = new DownloadQueueManager({
        delayFn: async () => {
            throw new Error("Timer subsystem failure");
        },
        downloadMaterial: async () => {
            throw new TypeError("Failed to fetch");
        },
        saveMaterial: async () => ({ filename: "unused", size: 0, path: "unused" })
    });
    crashManager.loadQueue([
        { fileId: "CRASH_ITEM_1", topic: "First" },
        { fileId: "PENDING_ITEM_2", topic: "Second" }
    ]);
    const crashRes = await crashManager.start();
    assert.equal(crashRes.ok, false);
    assert.equal(crashRes.snapshot.queueState, QUEUE_STATES.COMPLETED_WITH_ERRORS);
    assert.equal(crashRes.snapshot.failed, 1);
    assert.equal(crashRes.snapshot.skipped, 1);
    assert.equal(crashRes.snapshot.downloading, 0);
    assert.equal(crashRes.snapshot.retrying, 0);
    assert.equal(crashRes.snapshot.pending, 0);

    // 3. Throwing inside user-supplied onEvent callback does not corrupt queue execution
    const eventSafeManager = new DownloadQueueManager({
        delayFn: async () => {},
        onEvent: () => {
            throw new Error("Broken UI listener");
        },
        downloadMaterial: async ({ fileId }) => ({
            buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
            rawFilename: `${fileId}.pdf`,
            cleanFilename: `${fileId}.pdf`,
            contentType: "application/pdf",
            byteLength: 4
        }),
        saveMaterial: async ({ downloadResult }) => ({
            filename: downloadResult.cleanFilename,
            size: 4,
            path: `Root/${downloadResult.cleanFilename}`
        })
    });
    eventSafeManager.loadQueue([{ fileId: "SAFE_1" }, { fileId: "SAFE_2" }]);
    const safeRun = await eventSafeManager.start();
    assert.equal(safeRun.ok, true);
    assert.equal(safeRun.snapshot.queueState, QUEUE_STATES.COMPLETED);
    assert.equal(safeRun.snapshot.completed, 2);
});

test("Stage 3A tests INVALID_HTML, INVALID_BINARY, 403, FS_WRITE_ERROR, intentional AbortError vs network AbortError, and ordered event sequence", async () => {
    const attempts = new Map();
    const eventSequence = [];

    const manager = new DownloadQueueManager({
        delayFn: async () => {},
        onEvent: (evt) => {
            eventSequence.push({
                type: evt.type,
                fileId: evt.fileId || null,
                state: evt.state || (evt.fileId ? evt.snapshot.items[0]?.state : evt.snapshot.queueState),
                attempt: evt.attempt || null,
                willRetry: evt.willRetry ?? null
            });
        },
        downloadMaterial: async ({ fileId }) => {
            const count = (attempts.get(fileId) || 0) + 1;
            attempts.set(fileId, count);

            if (fileId === "NET_ABORT_RETRY") {
                if (count === 1) {
                    const abortTimeout = new Error("The operation was aborted due to timeout");
                    abortTimeout.name = "AbortError";
                    throw abortTimeout;
                }
                return {
                    buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                    rawFilename: "ok.pdf",
                    cleanFilename: "ok.pdf",
                    contentType: "application/pdf",
                    byteLength: 4
                };
            }
            if (fileId === "INTENTIONAL_PAUSE") {
                throw createIntentionalAbortError(ABORT_REASONS.PAUSE);
            }
            if (fileId === "INTENTIONAL_CANCEL") {
                throw createIntentionalAbortError(ABORT_REASONS.CANCEL);
            }
            if (fileId === "BAD_HTML") {
                throw { code: "INVALID_HTML", status: 200, message: "Unexpected HTML page" };
            }
            if (fileId === "BAD_BINARY") {
                throw new DownloadError("INVALID_PDF", "Corrupt PDF header", 200);
            }
            if (fileId === "FORBIDDEN_403") {
                throw new DownloadError("SESSION_EXPIRED", "Access forbidden", 403);
            }
            return {
                buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                rawFilename: `${fileId}.pdf`,
                cleanFilename: `${fileId}.pdf`,
                contentType: "application/pdf",
                byteLength: 4
            };
        },
        saveMaterial: async ({ material, downloadResult }) => {
            if (material.fileId === "DISK_FULL") {
                const err = new Error("Quota exceeded");
                err.name = "QuotaExceededError";
                throw err;
            }
            return {
                filename: downloadResult.cleanFilename,
                size: 4,
                path: `Root/${downloadResult.cleanFilename}`
            };
        }
    });

    // Verify deterministic ordered event sequence on retry-then-success first
    manager.loadQueue([{ fileId: "NET_ABORT_RETRY", topic: "Timeout Retry" }]);
    const retryOnly = await manager.start();
    assert.equal(retryOnly.ok, true);
    assert.equal(retryOnly.snapshot.queueState, QUEUE_STATES.COMPLETED);
    assert.equal(retryOnly.snapshot.items[0].attempts, 2);

    assert.deepEqual(
        eventSequence.map((e) => `${e.type}:${e.state}${e.attempt ? `#${e.attempt}` : ""}`),
        [
            "queue:started:running",
            "material:state_changed:downloading",
            "material:attempt_started:downloading#1",
            "material:attempt_failed:downloading#1",
            "material:state_changed:retrying",
            "material:state_changed:downloading",
            "material:attempt_started:downloading#2",
            "material:state_changed:completed",
            "material:completed:completed",
            "queue:completed:completed"
        ]
    );

    // Reload completed manager cleanly for non-retryable failure & intentional abort checks
    const reload = manager.loadQueue([
        { fileId: "INTENTIONAL_PAUSE" },
        { fileId: "INTENTIONAL_CANCEL" },
        { fileId: "BAD_HTML" },
        { fileId: "BAD_BINARY" },
        { fileId: "FORBIDDEN_403" },
        { fileId: "DISK_FULL" }
    ]);
    assert.equal(reload.ok, true);

    const run2 = await manager.start();
    assert.equal(run2.snapshot.queueState, QUEUE_STATES.COMPLETED_WITH_ERRORS);
    const byId = Object.fromEntries(run2.snapshot.items.map((i) => [i.fileId, i]));

    assert.equal(byId.INTENTIONAL_PAUSE.attempts, 1);
    assert.equal(byId.INTENTIONAL_PAUSE.error.category, ERROR_CATEGORIES.ABORTED_BY_PAUSE);

    assert.equal(byId.INTENTIONAL_CANCEL.attempts, 1);
    assert.equal(byId.INTENTIONAL_CANCEL.error.category, ERROR_CATEGORIES.ABORTED_BY_CANCEL);

    assert.equal(byId.BAD_HTML.attempts, 1);
    assert.equal(byId.BAD_HTML.error.category, ERROR_CATEGORIES.INVALID_HTML);

    assert.equal(byId.BAD_BINARY.attempts, 1);
    assert.equal(byId.BAD_BINARY.error.category, ERROR_CATEGORIES.INVALID_BINARY);

    assert.equal(byId.FORBIDDEN_403.attempts, 1);
    assert.equal(byId.FORBIDDEN_403.error.category, ERROR_CATEGORIES.FORBIDDEN);

    assert.equal(byId.DISK_FULL.attempts, 1);
    assert.equal(byId.DISK_FULL.error.category, ERROR_CATEGORIES.FS_WRITE_ERROR);

    // Tightened network matching does not classify generic programming Error("fetch config invalid") as retryable
    const progErr = classifyDownloadError(new Error("Internal config invalid before fetch"));
    assert.equal(progErr.category, ERROR_CATEGORIES.UNKNOWN_ERROR);
    assert.equal(progErr.retryable, false);

    // Quoted JSON-style and unquoted secrets are scrubbed
    const scrubbed = sanitizeErrorMessage(
        'Failed with {"_csrf": "secret-uuid-123", "authorizedID": "REG999"} and JSESSIONID=ABCXYZ'
    );
    assert.equal(scrubbed.includes("secret-uuid-123"), false);
    assert.equal(scrubbed.includes("REG999"), false);
    assert.equal(scrubbed.includes("ABCXYZ"), false);
});

test("Stage 3A distinguishes genuine fetch TypeErrors from unrelated programming TypeErrors", async () => {
    for (const msg of [
        "Failed to fetch",
        "fetch failed",
        "Load failed",
        "NetworkError when attempting to fetch resource."
    ]) {
        const classified = classifyDownloadError(new TypeError(msg));
        assert.equal(classified.category, ERROR_CATEGORIES.NETWORK_ERROR);
        assert.equal(classified.retryable, true);
    }

    const causeErr = new TypeError("unexpected wrapper", { cause: { code: "ECONNRESET" } });
    assert.equal(classifyDownloadError(causeErr).category, ERROR_CATEGORIES.NETWORK_ERROR);

    for (const msg of [
        "Cannot read properties of undefined",
        "Cannot read properties of undefined (reading 'id')",
        "Assignment to constant variable."
    ]) {
        const classified = classifyDownloadError(new TypeError(msg));
        assert.equal(classified.category, ERROR_CATEGORIES.UNKNOWN_ERROR);
        assert.equal(classified.retryable, false);
    }

    const attempts = new Map();
    const manager = new DownloadQueueManager({
        delayFn: async () => {},
        downloadMaterial: async ({ fileId }) => {
            const count = (attempts.get(fileId) || 0) + 1;
            attempts.set(fileId, count);

            if (fileId === "PROG_TYPE_ERR") {
                throw new TypeError("Cannot read properties of undefined");
            }
            if (fileId === "FETCH_TYPE_ERR" && count < 2) {
                throw new TypeError("Failed to fetch");
            }

            return {
                buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                rawFilename: `${fileId}.pdf`,
                cleanFilename: `${fileId}.pdf`,
                contentType: "application/pdf",
                byteLength: 4
            };
        },
        saveMaterial: async ({ downloadResult }) => ({
            filename: downloadResult.cleanFilename,
            size: 4,
            path: `Root/${downloadResult.cleanFilename}`
        })
    });

    manager.loadQueue([
        { fileId: "PROG_TYPE_ERR", topic: "Programming TypeError" },
        { fileId: "FETCH_TYPE_ERR", topic: "Genuine Fetch TypeError" }
    ]);

    const { snapshot } = await manager.start();
    assert.equal(snapshot.queueState, QUEUE_STATES.COMPLETED_WITH_ERRORS);
    assert.equal(snapshot.completed, 1);
    assert.equal(snapshot.failed, 1);

    const byId = Object.fromEntries(snapshot.items.map((item) => [item.fileId, item]));
    assert.equal(byId.PROG_TYPE_ERR.state, MATERIAL_STATES.FAILED);
    assert.equal(byId.PROG_TYPE_ERR.attempts, 1);
    assert.equal(byId.PROG_TYPE_ERR.error.category, ERROR_CATEGORIES.UNKNOWN_ERROR);

    assert.equal(byId.FETCH_TYPE_ERR.state, MATERIAL_STATES.COMPLETED);
    assert.equal(byId.FETCH_TYPE_ERR.attempts, 2);
});

test("Stage 3A rejects undefined and malformed saveMaterial results as non-retryable FS_WRITE_ERROR", async () => {
    const saveResponses = new Map([
        ["SAVE_UNDEFINED", undefined],
        ["SAVE_NULL", null],
        ["SAVE_STRING", "ok"],
        ["SAVE_EMPTY_OBJ", {}],
        ["SAVE_EMPTY_NAME", { filename: "   ", size: 4 }],
        ["SAVE_ZERO_SIZE", { filename: "zero.pdf", size: 0 }],
        ["SAVE_BAD_PATH", { filename: "badpath.pdf", size: 4, path: 123 }],
        ["SAVE_VALID", { filename: "valid.pdf", size: 4, path: "Root/valid.pdf" }]
    ]);

    const manager = new DownloadQueueManager({
        delayFn: async () => {},
        downloadMaterial: async ({ fileId }) => ({
            buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
            rawFilename: `${fileId}.pdf`,
            cleanFilename: `${fileId}.pdf`,
            contentType: "application/pdf",
            byteLength: 4
        }),
        saveMaterial: async ({ material }) => saveResponses.get(material.fileId)
    });

    manager.loadQueue(
        Array.from(saveResponses.keys()).map((fileId) => ({ fileId, topic: fileId }))
    );

    const result = await manager.start();
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.queueState, QUEUE_STATES.COMPLETED_WITH_ERRORS);
    assert.equal(result.snapshot.total, 8);
    assert.equal(result.snapshot.completed, 1);
    assert.equal(result.snapshot.failed, 7);
    assert.equal(result.snapshot.pending, 0);
    assert.equal(result.snapshot.downloading, 0);

    for (const item of result.snapshot.items) {
        if (item.fileId === "SAVE_VALID") {
            assert.equal(item.state, MATERIAL_STATES.COMPLETED);
            assert.equal(item.savedFilename, "valid.pdf");
            assert.equal(item.error, null);
        } else {
            assert.equal(item.state, MATERIAL_STATES.FAILED);
            assert.equal(item.attempts, 1);
            assert.equal(item.error.category, ERROR_CATEGORIES.FS_WRITE_ERROR);
            assert.equal(item.error.retryable, false);
            assert.equal(item.savedFilename, null);
        }
    }
});

function createChunkedStream(chunks) {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            controller.close();
        }
    });
}

test("Stage 3B downloadMaterial streams response chunks, reports determinate/indeterminate progress, and isolates callback errors", async () => {
    assert.equal(parseContentLength("1024"), 1024);
    assert.equal(parseContentLength("0"), null);
    assert.equal(parseContentLength("-5"), null);
    assert.equal(parseContentLength("invalid"), null);

    assert.deepEqual(buildProgressState(250, 1000), {
        bytesReceived: 250,
        totalBytes: 1000,
        percent: 25,
        indeterminate: false
    });
    assert.deepEqual(buildProgressState(250, null), {
        bytesReceived: 250,
        totalBytes: null,
        percent: null,
        indeterminate: true
    });

    const originalFetch = globalThis.fetch;
    const pdfPayload = new TextEncoder().encode("%PDF-1.4 streamed content bytes");
    const c1 = pdfPayload.slice(0, 8);
    const c2 = pdfPayload.slice(8, 20);
    const c3 = pdfPayload.slice(20);

    try {
        // 1. Known Content-Length -> accurate incremental bytes and percentages
        globalThis.fetch = async () =>
            new Response(createChunkedStream([c1, c2, c3]), {
                status: 200,
                headers: {
                    "content-type": "application/pdf",
                    "content-length": String(pdfPayload.byteLength),
                    "content-disposition":
                        'attachment; filename="FALLSEM2026-27_VL_BAECE202_00100_TH_2026-11-10_Notes1.pdf"'
                }
            });

        const knownProgress = [];
        const resKnown = await downloadMaterial({
            formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
            formEntries: [["_csrf", "c1"], ["_csrf", "c1"], ["authorizedID", "REG1"]],
            fileId: "9999000021",
            onProgress: (p) => knownProgress.push(p)
        });

        assert.deepEqual(knownProgress, [
            { bytesReceived: 8, totalBytes: 31, percent: 26, indeterminate: false },
            { bytesReceived: 20, totalBytes: 31, percent: 65, indeterminate: false },
            { bytesReceived: 31, totalBytes: 31, percent: 100, indeterminate: false }
        ]);
        assert.deepEqual(new Uint8Array(resKnown.buffer), pdfPayload);
        assert.equal(resKnown.cleanFilename, "Notes1.pdf");

        // 2. Unknown Content-Length -> indeterminate progress, never fabricates percentages
        globalThis.fetch = async () =>
            new Response(createChunkedStream([c1, c2, c3]), {
                status: 200,
                headers: {
                    "content-type": "application/pdf",
                    "content-disposition": 'attachment; filename="NoLength.pdf"'
                }
            });

        const unknownProgress = [];
        await downloadMaterial({
            formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
            formEntries: [["_csrf", "c1"]],
            fileId: "9999000022",
            onProgress: (p) => unknownProgress.push(p)
        });

        assert.deepEqual(unknownProgress, [
            { bytesReceived: 8, totalBytes: null, percent: null, indeterminate: true },
            { bytesReceived: 20, totalBytes: null, percent: null, indeterminate: true },
            { bytesReceived: 31, totalBytes: null, percent: null, indeterminate: true }
        ]);

        // 3. Throwing inside onProgress must not interrupt download or corrupt binary
        globalThis.fetch = async () =>
            new Response(createChunkedStream([c1, c2, c3]), {
                status: 200,
                headers: {
                    "content-type": "application/pdf",
                    "content-length": String(pdfPayload.byteLength),
                    "content-disposition": 'attachment; filename="Safe.pdf"'
                }
            });

        const resThrowingCb = await downloadMaterial({
            formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
            formEntries: [["_csrf", "c1"]],
            fileId: "9999000023",
            onProgress: () => {
                throw new Error("UI progress listener crashed");
            }
        });
        assert.deepEqual(new Uint8Array(resThrowingCb.buffer), pdfPayload);
        assert.equal(resThrowingCb.cleanFilename, "Safe.pdf");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Stage 3B integrates DownloadQueueManager + downloadMaterial + FileSystemSaveAdapter with live progress, retries, and both organization modes", async () => {
    const originalFetch = globalThis.fetch;
    const writtenFiles = new Map();

    function makeMockDir(prefix = "Dest") {
        const subdirs = new Map();
        const files = new Map();
        return {
            name: prefix,
            getDirectoryHandle: async (name) => {
                if (!subdirs.has(name)) {
                    subdirs.set(name, makeMockDir(`${prefix}/${name}`));
                }
                return subdirs.get(name);
            },
            keys: async function* () {
                for (const k of files.keys()) yield k;
            },
            getFileHandle: async (fileName) => {
                let dataBytes = files.get(fileName) || new Uint8Array(0);
                return {
                    createWritable: async () => ({
                        write: async (data) => {
                            if (fileName === "SaveFail.pdf") {
                                const err = new Error("Disk quota exceeded");
                                err.name = "QuotaExceededError";
                                throw err;
                            }
                            dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                            files.set(fileName, dataBytes);
                            writtenFiles.set(`${prefix}/${fileName}`, dataBytes);
                        },
                        close: async () => {},
                        abort: async () => {}
                    }),
                    getFile: async () => ({ size: dataBytes.byteLength })
                };
            }
        };
    }

    const mockRoot = makeMockDir("StudyRoot");
    const saveAdapter = createFileSystemSaveAdapter({
        getRootHandle: async () => mockRoot,
        verifyDirectoryPermission: async () => "granted",
        ensureSubdirectory: async (root, segments) => {
            let cur = root;
            for (const seg of segments) {
                cur = await cur.getDirectoryHandle(seg, { create: true });
            }
            return cur;
        },
        writeBinaryFile
    });

    const pdfBytes = new TextEncoder().encode("%PDF-1.4\nCourse PDF payload");
    const pptxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
    const fetchAttempts = new Map();
    let activeFetches = 0;
    let maxConcurrentFetches = 0;

    globalThis.fetch = async (_url, init) => {
        activeFetches += 1;
        maxConcurrentFetches = Math.max(maxConcurrentFetches, activeFetches);
        try {
            const params = init.body;
            assert.deepEqual(params.getAll("_csrf"), ["csrf-secret-1", "csrf-secret-1"]);
            assert.equal(params.get("authorizedID"), "REG_SECRET_01");

            const fileId = params.get("fileId");
            const count = (fetchAttempts.get(fileId) || 0) + 1;
            fetchAttempts.set(fileId, count);

            await new Promise((r) => setTimeout(r, 5));

            if (fileId === "F_RETRY_PPTX" && count < 3) {
                return new Response("Server temporary error", { status: 503 });
            }

            if (fileId === "F_SAVE_FAIL") {
                return new Response(createChunkedStream([pdfBytes.slice(0, 10), pdfBytes.slice(10)]), {
                    status: 200,
                    headers: {
                        "content-type": "application/pdf",
                        "content-length": String(pdfBytes.byteLength),
                        "content-disposition": 'attachment; filename="SaveFail.pdf"'
                    }
                });
            }

            if (fileId === "F_RETRY_PPTX") {
                return new Response(createChunkedStream([pptxBytes.slice(0, 4), pptxBytes.slice(4)]), {
                    status: 200,
                    headers: {
                        "content-type":
                            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                        "content-length": String(pptxBytes.byteLength),
                        "content-disposition":
                            'attachment; filename="FALLSEM2026-27_VL_BAECE202_00100_TH_2026-11-10_Deck1.pptx"'
                    }
                });
            }

            return new Response(createChunkedStream([pdfBytes.slice(0, 12), pdfBytes.slice(12)]), {
                status: 200,
                headers: {
                    "content-type": "application/pdf",
                    "content-disposition":
                        'attachment; filename="FALLSEM2026-27_VL_BAECE202_00100_TH_2026-11-10_Handout.pdf"'
                }
            });
        } finally {
            activeFetches -= 1;
        }
    };

    try {
        const events = [];
        const manager = new DownloadQueueManager({
            delayFn: async () => {},
            downloadMaterial,
            saveMaterial: saveAdapter,
            onEvent: (evt) => events.push(evt)
        });

        // Mode A: course_faculty
        const loadA = manager.loadQueue(
            [
                { id: "m-1", fileId: "F_PDF", topic: "Handout", uploadedBy: "FACULTY ONE" },
                { id: "m-2", fileId: "F_RETRY_PPTX", topic: "Deck 1", uploadedBy: "FACULTY ONE" },
                { id: "m-3", fileId: "F_SAVE_FAIL", topic: "Save Fail", uploadedBy: "FACULTY ONE" }
            ],
            {
                course: { courseCode: "BAECE202", courseName: "Engineering Electromagnetics" },
                organizationMode: ORGANIZATION_MODES.COURSE_FACULTY,
                formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
                formEntries: [
                    ["_csrf", "csrf-secret-1"],
                    ["_csrf", "csrf-secret-1"],
                    ["authorizedID", "REG_SECRET_01"]
                ]
            }
        );
        assert.equal(loadA.ok, true);

        const resA = await manager.start();
        assert.equal(resA.ok, true);
        assert.equal(maxConcurrentFetches, 1);
        assert.equal(resA.snapshot.queueState, QUEUE_STATES.COMPLETED_WITH_ERRORS);
        assert.equal(resA.snapshot.completed, 2);
        assert.equal(resA.snapshot.failed, 1);

        const byId = Object.fromEntries(resA.snapshot.items.map((i) => [i.fileId, i]));
        assert.equal(byId.F_PDF.state, MATERIAL_STATES.COMPLETED);
        assert.equal(byId.F_PDF.savedFilename, "Handout.pdf");
        assert.equal(byId.F_RETRY_PPTX.state, MATERIAL_STATES.COMPLETED);
        assert.equal(byId.F_RETRY_PPTX.attempts, 3);
        assert.equal(byId.F_RETRY_PPTX.savedFilename, "Deck1.pptx");

        // HTTP 200 succeeded for F_SAVE_FAIL, but write threw -> MUST remain failed (1 attempt, no retry)
        assert.equal(byId.F_SAVE_FAIL.state, MATERIAL_STATES.FAILED);
        assert.equal(byId.F_SAVE_FAIL.attempts, 1);
        assert.equal(byId.F_SAVE_FAIL.error.category, ERROR_CATEGORIES.FS_WRITE_ERROR);

        // Verify byte-exact files written under Course/Faculty
        assert.deepEqual(
            writtenFiles.get("StudyRoot/BAECE202 - Engineering Electromagnetics/FACULTY ONE/Handout.pdf"),
            pdfBytes
        );
        assert.deepEqual(
            writtenFiles.get("StudyRoot/BAECE202 - Engineering Electromagnetics/FACULTY ONE/Deck1.pptx"),
            pptxBytes
        );

        // Verify progress events contain materialId, attempt, and accurate indeterminate/determinate data
        const progressEvents = events.filter((e) => e.type === QUEUE_EVENTS.MATERIAL_PROGRESS);
        const pdfProg = progressEvents.filter((e) => e.materialId === "m-1");
        assert.equal(pdfProg.length, 2);
        assert.equal(pdfProg[0].attempt, 1);
        assert.equal(pdfProg[0].progress.indeterminate, true);
        assert.equal(pdfProg[0].progress.bytesReceived, 12);

        const pptxProg = progressEvents.filter((e) => e.materialId === "m-2");
        assert.equal(pptxProg.length, 2);
        assert.equal(pptxProg[0].attempt, 3);
        assert.equal(pptxProg[0].progress.percent, 40);
        assert.equal(pptxProg[1].progress.percent, 100);

        // Verify zero auth secrets leak in snapshots or events
        const serialized = JSON.stringify({ snapshot: resA.snapshot, events });
        assert.equal(serialized.includes("csrf-secret-1"), false);
        assert.equal(serialized.includes("REG_SECRET_01"), false);

        // Mode B: course_only
        const loadB = manager.loadQueue(
            [{ id: "m-4", fileId: "F_COURSE_ONLY", topic: "Summary", uploadedBy: "FACULTY TWO" }],
            {
                course: { courseCode: "BAECE202", courseName: "Engineering Electromagnetics" },
                organizationMode: ORGANIZATION_MODES.COURSE_ONLY,
                formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
                formEntries: [
                    ["_csrf", "csrf-secret-1"],
                    ["_csrf", "csrf-secret-1"],
                    ["authorizedID", "REG_SECRET_01"]
                ]
            }
        );
        assert.equal(loadB.ok, true);
        const resB = await manager.start();
        assert.equal(resB.snapshot.queueState, QUEUE_STATES.COMPLETED);
        assert.deepEqual(
            writtenFiles.get("StudyRoot/BAECE202 - Engineering Electromagnetics/Handout.pdf"),
            pdfBytes
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Stage 3B 404 disambiguation detects login redirects/HTML markers safely, bounds body reads to 2KB, and triggers batch warning only on all-404", async () => {
    const originalFetch = globalThis.fetch;

    try {
        // 1. 404 with login redirect URL -> SESSION_EXPIRED (isAuthFailure: true -> AUTH_EXPIRED)
        globalThis.fetch = async () => ({
            ok: false,
            status: 404,
            redirected: true,
            url: "https://vtop.vit.ac.in/vtop/login",
            headers: new Headers({ "content-type": "text/html" }),
            body: { cancel: async () => {} }
        });

        await assert.rejects(
            () =>
                downloadMaterial({
                    formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
                    formEntries: [["_csrf", "csrf-tok"], ["authorizedID", "REG123"]],
                    fileId: "F_404_LOGIN_URL"
                }),
            (err) => {
                assert.equal(err.code, "SESSION_EXPIRED");
                assert.equal(err.status, 404);
                assert.equal(err.isAuthFailure, true);
                assert.equal(classifyDownloadError(err).category, ERROR_CATEGORIES.AUTH_EXPIRED);
                return true;
            }
        );

        // 2. 404 HTML with session-expiry marker -> SESSION_EXPIRED without leaking HTML or secrets
        const sessionHtml = new TextEncoder().encode(
            "<!DOCTYPE html><html><body><div>Your session has expired. Please login again.</div></body></html>"
        );
        globalThis.fetch = async () =>
            new Response(createChunkedStream([sessionHtml]), {
                status: 404,
                headers: { "content-type": "text/html;charset=utf-8" }
            });

        await assert.rejects(
            () =>
                downloadMaterial({
                    formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
                    formEntries: [["_csrf", "csrf-tok"], ["authorizedID", "REG123"]],
                    fileId: "F_404_HTML_SESSION"
                }),
            (err) => {
                assert.equal(err.code, "SESSION_EXPIRED");
                assert.equal(err.isAuthFailure, true);
                assert.equal(err.message.includes("<html>"), false);
                assert.equal(err.message.includes("csrf-tok"), false);
                return true;
            }
        );

        // 3. Ordinary non-HTML 404 -> MATERIAL_NOT_FOUND
        globalThis.fetch = async () =>
            new Response("Not Found", {
                status: 404,
                headers: { "content-type": "text/plain" }
            });

        await assert.rejects(
            () =>
                downloadMaterial({
                    formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
                    formEntries: [["_csrf", "csrf-tok"]],
                    fileId: "F_404_PLAIN"
                }),
            (err) => err.code === "MATERIAL_NOT_FOUND" && err.status === 404 && !err.isAuthFailure
        );

        // 4. Generic HTML 404 without auth evidence -> MATERIAL_NOT_FOUND
        const generic404Html = new TextEncoder().encode(
            "<!DOCTYPE html><html><body><h1>404 Not Found</h1><p>Requested material file does not exist.</p></body></html>"
        );
        globalThis.fetch = async () =>
            new Response(createChunkedStream([generic404Html]), {
                status: 404,
                headers: { "content-type": "text/html" }
            });

        await assert.rejects(
            () =>
                downloadMaterial({
                    formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
                    formEntries: [["_csrf", "csrf-tok"]],
                    fileId: "F_404_GENERIC_HTML"
                }),
            (err) => err.code === "MATERIAL_NOT_FOUND" && !err.isAuthFailure
        );

        // 5. Oversized 404 HTML response (>2 KB) must cancel stream at <= 2 KB without consuming full body
        let pulledChunks = 0;
        let cancelled = false;
        const oversizedStream = new ReadableStream({
            pull(controller) {
                pulledChunks += 1;
                if (pulledChunks <= 20) {
                    // 20 * 1024 = 20 KB; marker placed only in chunk 10 (beyond 2 KB cap)
                    const chunkText =
                        pulledChunks === 10
                            ? "Session Expired ".padEnd(1024, "x")
                            : "<div>404 error</div>".padEnd(1024, " ");
                    controller.enqueue(new TextEncoder().encode(chunkText));
                } else {
                    controller.close();
                }
            },
            cancel() {
                cancelled = true;
            }
        });

        globalThis.fetch = async () =>
            new Response(oversizedStream, {
                status: 404,
                headers: { "content-type": "text/html" }
            });

        await assert.rejects(
            () =>
                downloadMaterial({
                    formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
                    formEntries: [["_csrf", "csrf-tok"]],
                    fileId: "F_404_OVERSIZED"
                }),
            (err) => err.code === "MATERIAL_NOT_FOUND"
        );
        assert.equal(cancelled, true);
        assert.ok(pulledChunks <= 3, `Expected bounded read <=3 chunks, pulled ${pulledChunks}`);

        // 6. Batch all-404 warning conditions
        const makeSnap = (overrides) => ({
            queueState: QUEUE_STATES.COMPLETED_WITH_ERRORS,
            completed: 0,
            failed: 2,
            cancelled: 0,
            items: [
                { state: MATERIAL_STATES.FAILED, error: { category: ERROR_CATEGORIES.NOT_FOUND } },
                { state: MATERIAL_STATES.FAILED, error: { category: ERROR_CATEGORIES.NOT_FOUND } }
            ],
            ...overrides
        });

        // Exact match -> shows warning
        assert.equal(
            getAll404SessionWarning(makeSnap(), QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS),
            ALL_404_SESSION_WARNING
        );
        // Some completed -> null
        assert.equal(
            getAll404SessionWarning(
                makeSnap({
                    completed: 1,
                    failed: 1,
                    items: [
                        { state: MATERIAL_STATES.COMPLETED, error: null },
                        { state: MATERIAL_STATES.FAILED, error: { category: ERROR_CATEGORIES.NOT_FOUND } }
                    ]
                }),
                QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS
            ),
            null
        );
        // Mixed failure categories -> null
        assert.equal(
            getAll404SessionWarning(
                makeSnap({
                    items: [
                        { state: MATERIAL_STATES.FAILED, error: { category: ERROR_CATEGORIES.NOT_FOUND } },
                        { state: MATERIAL_STATES.FAILED, error: { category: ERROR_CATEGORIES.FORBIDDEN } }
                    ]
                }),
                QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS
            ),
            null
        );
        // Cancelled or non-terminal -> null
        assert.equal(
            getAll404SessionWarning(
                makeSnap({ cancelled: 1 }),
                QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS
            ),
            null
        );
        assert.equal(
            getAll404SessionWarning(
                makeSnap({ queueState: QUEUE_STATES.CANCELLING }),
                QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS
            ),
            null
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Stage 3C pause aborts active transfer without triggering retry, resume restarts interrupted file, and progress/sequentiality hold", async () => {
    const originalFetch = globalThis.fetch;
    const pdfPayload = new TextEncoder().encode("%PDF-1.4\nResumed stream body");
    const fetchCalls = [];
    const abortedSignals = [];
    let activeFetches = 0;
    let maxConcurrentFetches = 0;
    let resolveF2Started = null;
    const f2StartedPromise = new Promise((r) => {
        resolveF2Started = r;
    });
    let releaseF2Stream = null;
    let f2FirstAttempt = true;

    globalThis.fetch = async (_url, init) => {
        activeFetches += 1;
        maxConcurrentFetches = Math.max(maxConcurrentFetches, activeFetches);
        const fileId = init.body.get("fileId");
        fetchCalls.push(fileId);

        try {
            assert.ok(init.signal instanceof AbortSignal);

            if (fileId === "F2" && f2FirstAttempt) {
                f2FirstAttempt = false;
                init.signal.addEventListener("abort", () => {
                    abortedSignals.push({ fileId, reason: init.signal.reason });
                });

                const stalledStream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(pdfPayload.slice(0, 6));
                        resolveF2Started();
                    },
                    pull() {
                        return new Promise((resolve) => {
                            releaseF2Stream = resolve;
                        });
                    },
                    cancel() {
                        releaseF2Stream?.();
                    }
                });

                return new Response(stalledStream, {
                    status: 200,
                    headers: {
                        "content-type": "application/pdf",
                        "content-length": String(pdfPayload.byteLength),
                        "content-disposition": 'attachment; filename="F2.pdf"'
                    }
                });
            }

            return new Response(createChunkedStream([pdfPayload.slice(0, 10), pdfPayload.slice(10)]), {
                status: 200,
                headers: {
                    "content-type": "application/pdf",
                    "content-length": String(pdfPayload.byteLength),
                    "content-disposition": `attachment; filename="${fileId}.pdf"`
                }
            });
        } finally {
            activeFetches -= 1;
        }
    };

    try {
        const events = [];
        const savedFiles = [];
        const manager = new DownloadQueueManager({
            delayFn: async () => {},
            downloadMaterial,
            saveMaterial: async ({ material, downloadResult }) => {
                savedFiles.push(material.fileId);
                return {
                    filename: downloadResult.cleanFilename,
                    size: downloadResult.byteLength,
                    path: `Root/${downloadResult.cleanFilename}`
                };
            },
            onEvent: (evt) => events.push(evt)
        });

        manager.loadQueue(
            [
                { id: "i-1", fileId: "F1", topic: "File 1" },
                { id: "i-2", fileId: "F2", topic: "File 2" },
                { id: "i-3", fileId: "F3", topic: "File 3" }
            ],
            {
                course: { courseCode: "BAECE203", courseName: "Analog Electronics" },
                organizationMode: ORGANIZATION_MODES.COURSE_ONLY,
                formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
                formEntries: [["_csrf", "secret-csrf-3c"], ["authorizedID", "SECRET_ID_3C"]]
            }
        );

        const startPromise = manager.start();
        await f2StartedPromise;

        const pauseRes = await manager.pause();
        assert.equal(pauseRes.ok, true);
        assert.equal(pauseRes.snapshot.queueState, QUEUE_STATES.PAUSED);
        assert.equal(pauseRes.snapshot.canResume, true);
        assert.equal(pauseRes.snapshot.canPause, false);
        assert.equal(pauseRes.snapshot.completed, 1);
        assert.equal(pauseRes.snapshot.pending, 2);
        assert.equal(pauseRes.snapshot.downloading, 0);
        assert.equal(pauseRes.snapshot.retrying, 0);

        // Active transfer aborted intentionally by pause; no automatic retry triggered
        assert.equal(abortedSignals.length, 1);
        assert.equal(abortedSignals[0].fileId, "F2");
        assert.equal(abortedSignals[0].reason.abortReason, ABORT_REASONS.PAUSE);
        assert.equal(
            events.some((e) => e.type === QUEUE_EVENTS.MATERIAL_ATTEMPT_FAILED && e.fileId === "F2"),
            false
        );
        assert.equal(
            events.some((e) => e.type === QUEUE_EVENTS.MATERIAL_STATE_CHANGED && e.state === MATERIAL_STATES.RETRYING),
            false
        );

        // Duplicate pause while already paused is safely rejected
        const doublePause = await manager.pause();
        assert.equal(doublePause.ok, false);
        assert.equal(doublePause.code, "QUEUE_ALREADY_PAUSED");

        // Snapshot immutability check while paused
        assert.equal(Object.isFrozen(pauseRes.snapshot), true);
        assert.equal(Object.isFrozen(pauseRes.snapshot.items), true);
        assert.equal(Object.isFrozen(pauseRes.snapshot.items[0]), true);

        const resumeRes = await manager.resume();
        const startRes = await startPromise;

        assert.equal(resumeRes.ok, true);
        assert.equal(startRes.ok, true);
        assert.equal(startRes.snapshot.queueState, QUEUE_STATES.COMPLETED);
        assert.equal(startRes.snapshot.completed, 3);
        assert.equal(maxConcurrentFetches, 1);

        // F1 never re-downloaded; F2 restarted from beginning; F3 downloaded once
        assert.deepEqual(fetchCalls, ["F1", "F2", "F2", "F3"]);
        assert.deepEqual(savedFiles, ["F1", "F2", "F3"]);

        // Verify queue state transitions running -> paused -> running -> completed
        const queueStateSequence = events.map((e) => e.snapshot.queueState);
        assert.ok(queueStateSequence.includes(QUEUE_STATES.RUNNING));
        assert.ok(queueStateSequence.includes(QUEUE_STATES.PAUSED));
        assert.equal(events.some((e) => e.type === QUEUE_EVENTS.QUEUE_PAUSED), true);
        assert.equal(events.some((e) => e.type === QUEUE_EVENTS.QUEUE_RESUMED), true);
        assert.equal(queueStateSequence[queueStateSequence.length - 1], QUEUE_STATES.COMPLETED);

        // Progress events continued working after resume for F2
        const f2ProgressAfterResume = events.filter(
            (e) =>
                e.type === QUEUE_EVENTS.MATERIAL_PROGRESS &&
                e.fileId === "F2" &&
                e.progress.percent === 100
        );
        assert.equal(f2ProgressAfterResume.length, 1);

        // Secrets never leak into snapshots or events
        const serialized = JSON.stringify({ snapshot: startRes.snapshot, events });
        assert.equal(serialized.includes("secret-csrf-3c"), false);
        assert.equal(serialized.includes("SECRET_ID_3C"), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Stage 3C pause between files (during save) and cancel during active transfer and while paused", async () => {
    // 1. Pause between files during saveMaterial
    let releaseSave1 = null;
    const save1Entered = new Promise((r) => {
        // resolved inside saveMaterial
    });
    let notifySave1Entered = null;
    const waitSave1 = new Promise((r) => {
        notifySave1Entered = r;
    });
    const downloadedOrder = [];

    const betweenPauseManager = new DownloadQueueManager({
        delayFn: async () => {},
        downloadMaterial: async ({ fileId }) => {
            downloadedOrder.push(fileId);
            return {
                buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                rawFilename: `${fileId}.pdf`,
                cleanFilename: `${fileId}.pdf`,
                contentType: "application/pdf",
                byteLength: 4
            };
        },
        saveMaterial: async ({ material, downloadResult }) => {
            if (material.fileId === "B1") {
                notifySave1Entered();
                await new Promise((resolve) => {
                    releaseSave1 = resolve;
                });
            }
            return {
                filename: downloadResult.cleanFilename,
                size: 4,
                path: `Root/${downloadResult.cleanFilename}`
            };
        }
    });

    betweenPauseManager.loadQueue([{ fileId: "B1" }, { fileId: "B2" }]);
    const betweenStart = betweenPauseManager.start();
    await waitSave1;
    const betweenPause = betweenPauseManager.pause();
    releaseSave1();
    const pausedSnap = await betweenPause;

    assert.equal(pausedSnap.ok, true);
    assert.equal(pausedSnap.snapshot.queueState, QUEUE_STATES.PAUSED);
    assert.equal(pausedSnap.snapshot.completed, 1);
    assert.equal(pausedSnap.snapshot.pending, 1);
    assert.deepEqual(downloadedOrder, ["B1"]);

    // Cancel while paused -> remaining pending item marked cancelled; completed stays completed
    const cancelledFromPause = await betweenPauseManager.cancel();
    await betweenStart;
    assert.equal(cancelledFromPause.ok, true);
    assert.equal(cancelledFromPause.snapshot.queueState, QUEUE_STATES.COMPLETED_WITH_ERRORS);
    assert.equal(cancelledFromPause.snapshot.completed, 1);
    assert.equal(cancelledFromPause.snapshot.cancelled, 1);
    assert.equal(cancelledFromPause.snapshot.items[0].state, MATERIAL_STATES.COMPLETED);
    assert.equal(cancelledFromPause.snapshot.items[1].state, MATERIAL_STATES.CANCELLED);
    assert.deepEqual(downloadedOrder, ["B1"]);

    // Cancelled queue cannot restart accidentally
    const restartCancelled = await betweenPauseManager.start();
    assert.equal(restartCancelled.ok, false);
    assert.equal(restartCancelled.code, "INVALID_QUEUE_STATE");
    const retryCancelled = await betweenPauseManager.retryFailed();
    assert.equal(retryCancelled.ok, false);
    assert.equal(retryCancelled.code, "NO_FAILED_MATERIALS");

    // 2. Cancel during active network transfer aborts request and prevents pending transfers
    let c2Aborted = false;
    let notifyC2Started = null;
    const waitC2 = new Promise((r) => {
        notifyC2Started = r;
    });
    const activeDownloads = [];
    const activeEvents = [];

    const cancelActiveManager = new DownloadQueueManager({
        delayFn: async () => {},
        onEvent: (evt) => activeEvents.push(evt),
        downloadMaterial: async ({ fileId, signal }) => {
            activeDownloads.push(fileId);
            if (fileId === "C2") {
                notifyC2Started();
                await new Promise((_, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => {
                            c2Aborted = true;
                            reject(signal.reason);
                        },
                        { once: true }
                    );
                });
            }
            return {
                buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                rawFilename: `${fileId}.pdf`,
                cleanFilename: `${fileId}.pdf`,
                contentType: "application/pdf",
                byteLength: 4
            };
        },
        saveMaterial: async ({ downloadResult }) => ({
            filename: downloadResult.cleanFilename,
            size: 4,
            path: `Root/${downloadResult.cleanFilename}`
        })
    });

    cancelActiveManager.loadQueue([{ fileId: "C1" }, { fileId: "C2" }, { fileId: "C3" }]);
    const cancelStartPromise = cancelActiveManager.start();
    await waitC2;
    const cancelResult = await cancelActiveManager.cancel();
    const cancelStartDone = await cancelStartPromise;

    assert.equal(c2Aborted, true);
    assert.equal(cancelResult.ok, true);
    assert.equal(cancelStartDone.snapshot.queueState, QUEUE_STATES.COMPLETED_WITH_ERRORS);
    assert.deepEqual(activeDownloads, ["C1", "C2"]);
    assert.equal(cancelStartDone.snapshot.completed, 1);
    assert.equal(cancelStartDone.snapshot.cancelled, 2);
    assert.equal(cancelStartDone.snapshot.items[0].state, MATERIAL_STATES.COMPLETED);
    assert.equal(cancelStartDone.snapshot.items[1].state, MATERIAL_STATES.CANCELLED);
    assert.equal(cancelStartDone.snapshot.items[2].state, MATERIAL_STATES.CANCELLED);
    assert.equal(activeEvents.some((e) => e.type === QUEUE_EVENTS.QUEUE_CANCELLED), true);
    assert.equal(
        activeEvents.some((e) => e.type === QUEUE_EVENTS.MATERIAL_STATE_CHANGED && e.state === MATERIAL_STATES.RETRYING),
        false
    );
});

test("Stage 3C manual retry processes failed items only, preserves metadata/courseType, distinguishes retry cycles, and surfaces auth expiry guidance", async () => {
    const attemptHistory = [];
    const savedPaths = [];
    const events = [];
    let activeCount = 0;
    let maxConcurrency = 0;
    let shouldFailNetOnce = true;
    let shouldRecover503 = false;

    const manager = new DownloadQueueManager({
        delayFn: async () => {},
        onEvent: (evt) => events.push(evt),
        downloadMaterial: async ({ fileId }) => {
            activeCount += 1;
            maxConcurrency = Math.max(maxConcurrency, activeCount);
            attemptHistory.push(fileId);
            try {
                if (fileId === "R_OK") {
                    // succeeds
                } else if (fileId === "R_RETRY_503") {
                    if (!shouldRecover503) {
                        throw { status: 503, message: "Temporary outage" };
                    }
                    if (shouldFailNetOnce) {
                        shouldFailNetOnce = false;
                        throw new TypeError("Failed to fetch");
                    }
                } else if (fileId === "R_AUTH") {
                    throw new DownloadError("SESSION_EXPIRED", "VTOP session expired", 401);
                } else if (fileId === "R_FS_FAIL") {
                    // download succeeds, saveMaterial throws
                }
                return {
                    buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                    rawFilename: `${fileId}.pdf`,
                    cleanFilename: `${fileId}.pdf`,
                    contentType: "application/pdf",
                    byteLength: 4
                };
            } finally {
                activeCount -= 1;
            }
        },
        saveMaterial: async ({ material, downloadResult, folderSegments }) => {
            if (material.fileId === "R_FS_FAIL" && material.manualRetryCount === 0) {
                const err = new Error("Permission denied");
                err.name = "NotAllowedError";
                throw err;
            }
            savedPaths.push(`${folderSegments.join("/")}/${downloadResult.cleanFilename}`);
            return {
                filename: downloadResult.cleanFilename,
                size: 4,
                path: `Root/${folderSegments.join("/")}/${downloadResult.cleanFilename}`
            };
        }
    });

    manager.loadQueue(
        [
            { id: "m1", fileId: "R_OK", topic: "OK Item", uploadedBy: "FACULTY ONE" },
            { id: "m2", fileId: "R_RETRY_503", topic: "Retryable 503", uploadedBy: "FACULTY ONE" },
            { id: "m3", fileId: "R_AUTH", topic: "Auth Fail", uploadedBy: "FACULTY ONE" },
            { id: "m4", fileId: "R_FS_FAIL", topic: "FS Fail", uploadedBy: "FACULTY ONE" }
        ],
        {
            course: {
                courseCode: "BAECE203",
                courseName: "Analog Electronics",
                courseType: "ETH - Embedded Theory"
            },
            organizationMode: ORGANIZATION_MODES.COURSE_FACULTY,
            formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
            formEntries: [["_csrf", "secret-tok-retry"], ["authorizedID", "REG_RETRY"]]
        }
    );

    const run1 = await manager.start();
    assert.equal(run1.snapshot.executionCycle, 1);
    assert.equal(run1.snapshot.completed, 1);
    assert.equal(run1.snapshot.failed, 3);
    // Automatic retries remain capped at 3; auth & FS fail in 1 attempt
    assert.deepEqual(attemptHistory, ["R_OK", "R_RETRY_503", "R_RETRY_503", "R_RETRY_503", "R_AUTH", "R_FS_FAIL"]);
    assert.equal(run1.snapshot.hasAuthFailure, true);
    assert.equal(getAuthExpiredWarning(run1.snapshot), AUTH_EXPIRED_SESSION_WARNING);

    // Retry only R_RETRY_503 and R_FS_FAIL (simulate user fixing permission & network recovering)
    attemptHistory.length = 0;
    shouldRecover503 = true;
    const run2 = await manager.retryFailed({ materialIds: ["m2", "m4"] });

    assert.equal(run2.ok, true);
    assert.equal(run2.snapshot.executionCycle, 2);
    assert.equal(maxConcurrency, 1);
    // Completed R_OK is NEVER downloaded again; R_RETRY_503 auto-retries once on cycle 2 and succeeds; R_FS_FAIL succeeds
    assert.deepEqual(attemptHistory, ["R_RETRY_503", "R_RETRY_503", "R_FS_FAIL"]);
    assert.equal(run2.snapshot.completed, 3);
    assert.equal(run2.snapshot.failed, 1);

    const byId = Object.fromEntries(run2.snapshot.items.map((i) => [i.id, i]));
    assert.equal(byId.m1.manualRetryCount, 0);
    assert.equal(byId.m2.manualRetryCount, 1);
    assert.equal(byId.m2.attempts, 2);
    assert.equal(byId.m2.totalAttempts, 5);
    assert.equal(byId.m4.manualRetryCount, 1);
    assert.equal(byId.m3.state, MATERIAL_STATES.FAILED); // untouched failed auth item

    // Preserved courseType + organizationMode folder structure
    assert.deepEqual(savedPaths, [
        "BAECE203 - Analog Electronics/ETH - Embedded Theory/FACULTY ONE/R_OK.pdf",
        "BAECE203 - Analog Electronics/ETH - Embedded Theory/FACULTY ONE/R_RETRY_503.pdf",
        "BAECE203 - Analog Electronics/ETH - Embedded Theory/FACULTY ONE/R_FS_FAIL.pdf"
    ]);

    assert.equal(
        events.some((e) => e.type === QUEUE_EVENTS.QUEUE_RETRY_STARTED && e.executionCycle === 2),
        true
    );
    const retryStartedEvent = events.find(
        (e) => e.type === QUEUE_EVENTS.MATERIAL_ATTEMPT_STARTED && e.materialId === "m2" && e.executionCycle === 2
    );
    assert.equal(retryStartedEvent.isManualRetry, true);
    assert.equal(retryStartedEvent.manualRetryCount, 1);

    const serialized = JSON.stringify({ snapshot: run2.snapshot, events });
    assert.equal(serialized.includes("secret-tok-retry"), false);
    assert.equal(serialized.includes("REG_RETRY"), false);
});

test("Stage 3C selective download helpers support Select All, Deselect All, Download Selected, Download All, and duplicate prevention", async () => {
    const course = {
        courseCode: "BAECE203",
        courseName: "Analog Electronics",
        courseType: "ELA - Embedded Lab"
    };
    const rawMaterials = [
        { rowNumber: "1", topic: "Lab 1", uploadedBy: "FACULTY A", fileId: "L001", hasValidFileId: true },
        { rowNumber: "2", topic: "Lab 2", uploadedBy: "FACULTY A", fileId: "L002", hasValidFileId: true },
        { rowNumber: "3", topic: "Lab 2 Dup", uploadedBy: "FACULTY A", fileId: "L002", hasValidFileId: true },
        { rowNumber: "4", topic: "No Attachment", uploadedBy: "FACULTY A", fileId: "", hasValidFileId: false }
    ];

    const prepared = prepareSelectableMaterials(rawMaterials, course);
    assert.equal(prepared.length, 4);
    assert.equal(prepared[0].courseType, "ELA - Embedded Lab");

    // Select All picks all valid-fileId materials, ignores invalid
    let selected = selectAllMaterials(prepared);
    assert.equal(countSelectedMaterials(prepared, selected), 3);
    assert.equal(selected.has(prepared[3].id), false);

    // Download Selected deduplicates duplicate fileIds cleanly
    const selectedAllPayload = buildSelectedDownloadPayload(prepared, selected, course);
    assert.deepEqual(
        selectedAllPayload.map((m) => m.fileId),
        ["L001", "L002"]
    );

    // Deselect All clears all
    selected = deselectAllMaterials();
    assert.equal(countSelectedMaterials(prepared, selected), 0);
    assert.deepEqual(buildSelectedDownloadPayload(prepared, selected, course), []);

    // Toggle individual item
    selected = toggleMaterialSelection(prepared, selected, prepared[1].id, true);
    selected = toggleMaterialSelection(prepared, selected, prepared[3].id, true); // invalid ignored
    assert.equal(countSelectedMaterials(prepared, selected), 1);
    const partialPayload = buildSelectedDownloadPayload(prepared, selected, course);
    assert.deepEqual(
        partialPayload.map((m) => m.fileId),
        ["L002"]
    );
    assert.equal(partialPayload[0].courseType, "ELA - Embedded Lab");

    // Download All includes every available material while queue manager skips duplicates/invalid
    const allPayload = buildAllDownloadPayload(prepared, course);
    assert.equal(allPayload.length, 4);

    const downloadedIds = [];
    const manager = new DownloadQueueManager({
        delayFn: async () => {},
        downloadMaterial: async ({ fileId }) => {
            downloadedIds.push(fileId);
            return {
                buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
                rawFilename: `${fileId}.pdf`,
                cleanFilename: `${fileId}.pdf`,
                contentType: "application/pdf",
                byteLength: 4
            };
        },
        saveMaterial: async ({ downloadResult, folderSegments }) => ({
            filename: downloadResult.cleanFilename,
            size: 4,
            path: `${folderSegments.join("/")}/${downloadResult.cleanFilename}`
        })
    });

    manager.loadQueue(partialPayload, {
        course,
        organizationMode: ORGANIZATION_MODES.COURSE_ONLY,
        formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
        formEntries: [["_csrf", "tok"]]
    });
    const selectedRun = await manager.start();
    assert.deepEqual(downloadedIds, ["L002"]);
    assert.equal(
        selectedRun.snapshot.items[0].savedPath,
        "BAECE203 - Analog Electronics/ELA - Embedded Lab/L002.pdf"
    );

    downloadedIds.length = 0;
    manager.loadQueue(allPayload, {
        course,
        organizationMode: ORGANIZATION_MODES.COURSE_ONLY,
        formAction: "https://vtop.vit.ac.in/vtop/downloadCourseMaterialFacultyPdf",
        formEntries: [["_csrf", "tok"]]
    });
    const allRun = await manager.start();
    assert.deepEqual(downloadedIds, ["L001", "L002"]);
    assert.equal(allRun.snapshot.completed, 2);
    assert.equal(allRun.snapshot.skipped, 2);
});

test("Stage 3C ETH and ELA metadata extraction and folder separation work across both modes without breaking untyped courses or creating duplicate folders", async () => {
    // 1. Folder organizer preserves compatibility for courses without ETH/ELA and separates ETH/ELA
    assert.equal(formatCourseTypeFolderSegment({ courseType: "ETH - Embedded Theory" }), "ETH - Embedded Theory");
    assert.equal(formatCourseTypeFolderSegment({ courseTypeCode: "ELA" }), "ELA - Embedded Lab");
    assert.equal(formatCourseTypeFolderSegment({ courseCode: "BAECE202" }), "");

    assert.deepEqual(
        buildTargetFolderSegments({
            course: {
                courseCode: "BAECE203",
                courseName: "Analog Electronics",
                courseType: "ETH - Embedded Theory"
            },
            uploadedBy: "FACULTY ONE",
            organizeByFaculty: true
        }),
        ["BAECE203 - Analog Electronics", "ETH - Embedded Theory", "FACULTY ONE"]
    );
    assert.deepEqual(
        buildTargetFolderSegments({
            course: {
                courseCode: "BAECE203",
                courseName: "Analog Electronics",
                courseType: "ELA - Embedded Lab"
            },
            uploadedBy: "FACULTY ONE",
            organizeByFaculty: true
        }),
        ["BAECE203 - Analog Electronics", "ELA - Embedded Lab", "FACULTY ONE"]
    );
    assert.deepEqual(
        buildTargetFolderSegments({
            course: {
                courseCode: "BAECE203",
                courseName: "Analog Electronics",
                courseType: "ELA - Embedded Lab"
            },
            uploadedBy: "FACULTY ONE",
            organizeByFaculty: false
        }),
        ["BAECE203 - Analog Electronics", "ELA - Embedded Lab"]
    );
    assert.deepEqual(
        buildTargetFolderSegments({
            course: { courseCode: "BAECE202", courseName: "Engineering Electromagnetics" },
            uploadedBy: "FACULTY ONE",
            organizeByFaculty: true
        }),
        ["BAECE202 - Engineering Electromagnetics", "FACULTY ONE"]
    );

    // 2. Parser extracts ETH/ELA from actual VTOP #courseId and courseDetail metadata, while single TH retains existing path
    async function runExtractionWithCourseOption(optionText, courseDetailCellText, optionsList = null) {
        const env = createMockBrowserEnv({ rowsTotal: 1, domVisible: 1, dtInitialized: true });
        const doc = env.sharedGlobal.document;
        const allOptions = optionsList
            ? optionsList.map((text) => ({ textContent: text }))
            : [{ textContent: optionText }];
        const selectedOption = { textContent: optionText };
        const origGetElementById = doc.getElementById;
        doc.getElementById = (id) => {
            if (id === "courseId") {
                return {
                    selectedOptions: [selectedOption],
                    options: allOptions
                };
            }
            return origGetElementById(id);
        };
        const table = origGetElementById("materialTable");
        const firstRow = table.querySelector("tbody tr");
        firstRow.cells[1].innerText = courseDetailCellText;
        runBridgeScripts(env.sharedGlobal);
        return await new Promise((resolve) => {
            env.runtimeMessageListeners[0](
                { type: "EXTRACT_COURSE_MATERIALS" },
                { id: "ext-id-stage2" },
                resolve
            );
        });
    }

    const ethExtraction = await runExtractionWithCourseOption(
        "Fall Semester 2026-27 - BAECE203 - Analog Electronics - ETH - Embedded Theory - 3.0",
        "Fall Semester 2026-27\nBAECE203 - Analog Electronics - ETH",
        [
            "Fall Semester 2026-27 - BAECE203 - Analog Electronics - ETH - Embedded Theory - 3.0",
            "Fall Semester 2026-27 - BAECE203 - Analog Electronics - ELA - Embedded Lab - 1.0"
        ]
    );
    assert.equal(ethExtraction.course.courseCode, "BAECE203");
    assert.equal(ethExtraction.course.courseName, "Analog Electronics");
    assert.equal(ethExtraction.course.courseType, "ETH - Embedded Theory");
    assert.equal(ethExtraction.materials[0].courseType, "ETH - Embedded Theory");

    const elaExtraction = await runExtractionWithCourseOption(
        "Fall Semester 2026-27 - BAECE203 - Analog Electronics - ELA - Embedded Lab - 1.0",
        "Fall Semester 2026-27\nBAECE203 - Analog Electronics - ELA",
        [
            "Fall Semester 2026-27 - BAECE203 - Analog Electronics - ETH - Embedded Theory - 3.0",
            "Fall Semester 2026-27 - BAECE203 - Analog Electronics - ELA - Embedded Lab - 1.0"
        ]
    );
    assert.equal(elaExtraction.course.courseCode, "BAECE203");
    assert.equal(elaExtraction.course.courseName, "Analog Electronics");
    assert.equal(elaExtraction.course.courseType, "ELA - Embedded Lab");
    assert.equal(elaExtraction.materials[0].courseType, "ELA - Embedded Lab");

    // Single TH course without sibling retains existing non-type path
    const thExtraction = await runExtractionWithCourseOption(
        "Fall Semester 2026-27 - BAECE202 - Engineering Electromagnetics - TH - Theory Only - 4.0",
        "Fall Semester 2026-27\nBAECE202 - Engineering Electromagnetics - TH"
    );
    assert.equal(thExtraction.course.courseCode, "BAECE202");
    assert.equal(thExtraction.course.courseType, "");
    assert.equal(thExtraction.materials[0].courseType, "");

    // 3. Repeated Download All operations reuse exact same folders in FileSystemSaveAdapter (no duplicate folders)
    const dirHandles = new Map();
    function getOrCreateDir(parentMap, name) {
        if (!parentMap.has(name)) {
            parentMap.set(name, { name, subdirs: new Map(), files: new Map() });
        }
        return parentMap.get(name);
    }
    const rootNode = { name: "VTOP_Root", subdirs: dirHandles, files: new Map() };
    function wrapDirHandle(node) {
        return {
            name: node.name,
            getDirectoryHandle: async (seg, { create } = {}) => {
                if (!node.subdirs.has(seg) && !create) {
                    throw new Error("NotFound");
                }
                return wrapDirHandle(getOrCreateDir(node.subdirs, seg));
            },
            keys: async function* () {
                for (const k of node.files.keys()) yield k;
            },
            getFileHandle: async (fileName) => {
                let bytes = node.files.get(fileName) || new Uint8Array(0);
                return {
                    createWritable: async () => ({
                        write: async (data) => {
                            bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                            node.files.set(fileName, bytes);
                        },
                        close: async () => {},
                        abort: async () => {}
                    }),
                    getFile: async () => ({ size: bytes.byteLength })
                };
            }
        };
    }

    const rootHandle = wrapDirHandle(rootNode);
    const saveAdapter = createFileSystemSaveAdapter({
        getRootHandle: async () => rootHandle,
        verifyDirectoryPermission: async () => "granted",
        ensureSubdirectory: async (root, segments) => {
            let cur = root;
            for (const s of segments) {
                cur = await cur.getDirectoryHandle(s, { create: true });
            }
            return cur;
        },
        writeBinaryFile
    });

    const queue = new DownloadQueueManager({
        delayFn: async () => {},
        downloadMaterial: async ({ fileId }) => ({
            buffer: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
            rawFilename: `${fileId}.pdf`,
            cleanFilename: `${fileId}.pdf`,
            contentType: "application/pdf",
            byteLength: 4
        }),
        saveMaterial: saveAdapter
    });

    // Run ETH twice and ELA once
    queue.loadQueue(ethExtraction.materials, {
        course: ethExtraction.course,
        organizationMode: ORGANIZATION_MODES.COURSE_FACULTY
    });
    await queue.start();

    queue.loadQueue(ethExtraction.materials, {
        course: ethExtraction.course,
        organizationMode: ORGANIZATION_MODES.COURSE_FACULTY
    });
    await queue.start();

    queue.loadQueue(elaExtraction.materials, {
        course: elaExtraction.course,
        organizationMode: ORGANIZATION_MODES.COURSE_FACULTY
    });
    await queue.start();

    // Only one top-level course folder, containing exactly two type folders (ETH and ELA)
    assert.deepEqual(Array.from(rootNode.subdirs.keys()), ["BAECE203 - Analog Electronics"]);
    const courseNode = rootNode.subdirs.get("BAECE203 - Analog Electronics");
    assert.deepEqual(
        Array.from(courseNode.subdirs.keys()).sort(),
        ["ELA - Embedded Lab", "ETH - Embedded Theory"]
    );
});
