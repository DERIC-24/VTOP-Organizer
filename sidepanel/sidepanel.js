import {
    createStage2TestFile,
    ensureSubdirectory,
    loadDirectoryHandle,
    pickAndSaveDirectory,
    requestDirectoryPermission,
    verifyDirectoryPermission,
    writeBinaryFile
} from "../services/file-system.js";
import { downloadMaterial } from "../services/download-service.js";
import {
    createFileSystemSaveAdapter,
    DownloadQueueManager,
    getAll404SessionWarning,
    ORGANIZATION_MODES,
    QUEUE_EVENTS
} from "../services/queue-manager.js";

const ORG_MODE_STORAGE_KEY = "vtop_organizer_org_mode";

const statusTitle = document.getElementById("status-title");
const statusDescription = document.getElementById("status-description");
const refreshButton = document.getElementById("refresh-button");

const folderNameEl = document.getElementById("folder-name");
const folderStatusEl = document.getElementById("folder-status");
const chooseFolderButton = document.getElementById("choose-folder-button");
const reauthorizeFolderButton = document.getElementById("reauthorize-folder-button");
const testFileButton = document.getElementById("test-file-button");
const fsFeedbackEl = document.getElementById("fs-feedback");

const courseNameEl = document.getElementById("course-name");
const courseCodeEl = document.getElementById("course-code");

const materialsBadgeEl = document.getElementById("materials-badge");
const materialsSummaryEl = document.getElementById("materials-summary");
const materialsErrorEl = document.getElementById("materials-error");
const materialsListEl = document.getElementById("materials-list");

const organizationModeSelect = document.getElementById("organization-mode");
const startDownloadButton = document.getElementById("start-download-button");
const queueProgressBox = document.getElementById("queue-progress-box");
const queueProgressText = document.getElementById("queue-progress-text");
const queueProgressPercent = document.getElementById("queue-progress-percent");
const queueProgressBar = document.getElementById("queue-progress-bar");
const fileProgressText = document.getElementById("file-progress-text");
const fileProgressPercent = document.getElementById("file-progress-percent");
const fileProgressBar = document.getElementById("file-progress-bar");

const state = {
    dirHandle: null,
    dirPermission: "none",
    extraction: null,
    queueRunning: false,
    itemStatusEls: new Map()
};

// Expose Stage 2 services on window for controlled console inspection without storing secrets
globalThis.__vtopOrganizerStage2 = {
    downloadMaterial
};

const saveMaterialAdapter = createFileSystemSaveAdapter({
    getRootHandle: () => state.dirHandle,
    verifyDirectoryPermission,
    ensureSubdirectory,
    writeBinaryFile
});

const queueManager = new DownloadQueueManager({
    downloadMaterial,
    saveMaterial: saveMaterialAdapter,
    onEvent: handleQueueEvent
});

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "0 B";
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function showFeedback(element, message, isError = false) {
    element.textContent = message;
    element.classList.remove("hidden", "error");
    if (isError) {
        element.classList.add("error");
    }
}

function hideElement(element) {
    element.classList.add("hidden");
    element.textContent = "";
}

function updateDownloadControlState() {
    const hasMaterials = Boolean(
        state.extraction?.ok &&
            state.extraction?.formAvailable &&
            Array.isArray(state.extraction?.materials) &&
            state.extraction.materials.some((m) => m.hasValidFileId)
    );
    const hasWritePermission = Boolean(state.dirHandle && state.dirPermission === "granted");

    startDownloadButton.disabled = state.queueRunning || !hasMaterials || !hasWritePermission;
    organizationModeSelect.disabled = state.queueRunning;
    refreshButton.disabled = state.queueRunning;
    chooseFolderButton.disabled = state.queueRunning;
    reauthorizeFolderButton.disabled = state.queueRunning;
    testFileButton.disabled = state.queueRunning || !hasWritePermission;
}

function renderQueueSnapshotProgress(snapshot) {
    if (!snapshot) {
        return;
    }
    queueProgressBox.classList.remove("hidden");
    queueProgressBar.max = Math.max(1, snapshot.total);
    queueProgressBar.value = snapshot.processed;
    queueProgressPercent.textContent = `${snapshot.queuePercent}%`;

    const summaryParts = [
        `${snapshot.processed}/${snapshot.total}`,
        `${snapshot.completed} ok`
    ];
    if (snapshot.failed > 0) {
        summaryParts.push(`${snapshot.failed} failed`);
    }
    if (snapshot.skipped > 0) {
        summaryParts.push(`${snapshot.skipped} skipped`);
    }
    queueProgressText.textContent = `Queue: ${summaryParts.join(" · ")}`;
}

function renderActiveFileProgress({ topic, attempt, maxAttempts, progress }) {
    if (!progress) {
        return;
    }
    const prefix = attempt ? `${topic} (Attempt ${attempt}/${maxAttempts})` : topic;

    if (progress.indeterminate) {
        fileProgressBar.removeAttribute("value");
        fileProgressText.textContent = `${prefix}: ${formatBytes(progress.bytesReceived)} received`;
        fileProgressPercent.textContent = "Streaming...";
    } else {
        fileProgressBar.max = progress.totalBytes;
        fileProgressBar.value = Math.min(progress.bytesReceived, progress.totalBytes);
        fileProgressText.textContent =
            `${prefix}: ${formatBytes(progress.bytesReceived)} / ${formatBytes(progress.totalBytes)}`;
        fileProgressPercent.textContent = `${progress.percent}%`;
    }
}

function updateMaterialItemBadge(fileId, text) {
    const tag = state.itemStatusEls.get(fileId);
    if (tag) {
        tag.textContent = text;
    }
}

function handleQueueEvent(event) {
    const { type, snapshot } = event;
    renderQueueSnapshotProgress(snapshot);

    if (type === QUEUE_EVENTS.QUEUE_STARTED) {
        state.queueRunning = true;
        updateDownloadControlState();
        fileProgressBar.removeAttribute("value");
        fileProgressText.textContent = "Starting sequential downloads...";
        fileProgressPercent.textContent = "";
        return;
    }

    if (type === QUEUE_EVENTS.MATERIAL_ATTEMPT_STARTED) {
        updateMaterialItemBadge(event.fileId, `Downloading (${event.attempt}/${event.maxAttempts})`);
        renderActiveFileProgress({
            topic: event.topic,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            progress: { bytesReceived: 0, totalBytes: null, percent: null, indeterminate: true }
        });
        return;
    }

    if (type === QUEUE_EVENTS.MATERIAL_PROGRESS) {
        renderActiveFileProgress({
            topic: event.topic,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            progress: event.progress
        });
        if (!event.progress.indeterminate) {
            updateMaterialItemBadge(event.fileId, `${event.progress.percent}%`);
        } else {
            updateMaterialItemBadge(event.fileId, formatBytes(event.progress.bytesReceived));
        }
        return;
    }

    if (type === QUEUE_EVENTS.MATERIAL_STATE_CHANGED) {
        if (event.state === "retrying") {
            updateMaterialItemBadge(event.fileId, `Retrying (${event.attempts})`);
        } else if (event.state === "failed") {
            updateMaterialItemBadge(event.fileId, `Failed (${event.error?.code || "ERROR"})`);
        } else if (event.state === "skipped") {
            updateMaterialItemBadge(event.fileId, "Skipped");
        }
        return;
    }

    if (type === QUEUE_EVENTS.MATERIAL_COMPLETED) {
        updateMaterialItemBadge(event.fileId, `Saved: ${event.savedFilename}`);
        renderActiveFileProgress({
            topic: event.savedFilename || event.topic,
            attempt: null,
            maxAttempts: null,
            progress: {
                bytesReceived: event.byteLength || 0,
                totalBytes: event.byteLength || null,
                percent: event.byteLength ? 100 : null,
                indeterminate: !event.byteLength
            }
        });
        return;
    }

    if (
        type === QUEUE_EVENTS.QUEUE_COMPLETED ||
        type === QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS
    ) {
        state.queueRunning = false;
        updateDownloadControlState();
        fileProgressText.textContent =
            type === QUEUE_EVENTS.QUEUE_COMPLETED
                ? `All ${snapshot.completed} file(s) downloaded and saved.`
                : `Finished: ${snapshot.completed} saved, ${snapshot.failed} failed.`;
        fileProgressPercent.textContent = "Done";
        fileProgressBar.max = 100;
        fileProgressBar.value = 100;

        if (type === QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS) {
            const warning = getAll404SessionWarning(snapshot, type);
            if (warning) {
                showFeedback(materialsErrorEl, warning, true);
            }
        }
    }
}

function resetCourseAndMaterials(summaryText = "Open Course Page Consolidated and click Refresh & Scan Course.") {
    state.extraction = null;
    state.itemStatusEls.clear();
    courseNameEl.textContent = "No course detected";
    courseCodeEl.textContent = "Waiting for VTOP course page";
    materialsBadgeEl.textContent = "0";
    materialsSummaryEl.textContent = summaryText;
    hideElement(materialsErrorEl);
    materialsListEl.innerHTML = "";
    materialsListEl.classList.add("hidden");
    queueProgressBox.classList.add("hidden");
    updateDownloadControlState();
}

function renderFolderState() {
    if (!state.dirHandle) {
        folderNameEl.textContent = "No folder selected";
        folderStatusEl.textContent = "Choose a folder to store course materials.";
        reauthorizeFolderButton.classList.add("hidden");
        updateDownloadControlState();
        return;
    }

    folderNameEl.textContent = state.dirHandle.name;

    if (state.dirPermission === "granted") {
        folderStatusEl.textContent = "Write access granted (persisted in IndexedDB).";
        reauthorizeFolderButton.classList.add("hidden");
    } else if (state.dirPermission === "prompt") {
        folderStatusEl.textContent = "Saved folder requires re-authorization after reload.";
        reauthorizeFolderButton.classList.remove("hidden");
    } else {
        folderStatusEl.textContent = "Folder permission denied. Please choose a folder again.";
        reauthorizeFolderButton.classList.add("hidden");
    }
    updateDownloadControlState();
}

function renderMaterials(extraction) {
    state.extraction = extraction;
    state.itemStatusEls.clear();

    const course = extraction.course || {};
    courseNameEl.textContent = course.courseName || "Unknown Course";
    courseCodeEl.textContent = course.courseCode || "Course code unavailable";

    const materials = Array.isArray(extraction.materials) ? extraction.materials : [];
    const stats = extraction.stats || {
        extractionMode: "unknown",
        domRowCount: 0,
        totalRows: materials.length,
        validFileIds: 0
    };

    materialsBadgeEl.textContent = String(materials.length);
    materialsSummaryEl.textContent =
        `${stats.totalRows} materials extracted via ${stats.extractionMode || "bridge"} (initial DOM: ${stats.domRowCount}, valid file IDs: ${stats.validFileIds}).`;

    if (!extraction.formAvailable && extraction.formError) {
        showFeedback(materialsErrorEl, extraction.formError, true);
    } else {
        hideElement(materialsErrorEl);
    }

    materialsListEl.innerHTML = "";
    if (materials.length === 0) {
        materialsListEl.classList.add("hidden");
        updateDownloadControlState();
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of materials) {
        const li = document.createElement("li");
        li.className = "material-item";

        const title = document.createElement("div");
        title.className = "material-title";
        title.textContent = `${item.rowNumber}. ${item.topic}`;

        const meta = document.createElement("div");
        meta.className = "material-meta";

        const faculty = document.createElement("span");
        faculty.textContent = item.uploadedBy || "Unknown faculty";

        const fileTag = document.createElement("span");
        fileTag.className = "file-id-tag";
        fileTag.textContent = item.hasValidFileId ? `ID: ${item.fileId}` : "No ID";
        if (item.hasValidFileId && !state.itemStatusEls.has(item.fileId)) {
            state.itemStatusEls.set(item.fileId, fileTag);
        }

        meta.append(faculty, fileTag);
        li.append(title, meta);
        fragment.appendChild(li);
    }

    materialsListEl.appendChild(fragment);
    materialsListEl.classList.remove("hidden");
    updateDownloadControlState();
}

async function ensureContentScriptsInjected(tabId) {
    await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/main-bridge.js"],
        world: "MAIN"
    });

    await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/course-parser.js", "content/vtop-detector.js"],
        world: "ISOLATED"
    });
}

async function sendTabMessageWithRecovery(tabId, message) {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes("Receiving end does not exist")) {
            throw error;
        }
        await ensureContentScriptsInjected(tabId);
        return await chrome.tabs.sendMessage(tabId, message);
    }
}

async function checkCurrentWebsite() {
    if (state.queueRunning) {
        return;
    }

    statusTitle.textContent = "Checking...";
    statusDescription.textContent = "Reading current browser tab.";
    hideElement(materialsErrorEl);

    try {
        const tabs = await chrome.tabs.query({
            active: true,
            lastFocusedWindow: true
        });

        const currentTab = tabs[0];
        if (!currentTab || !currentTab.id) {
            statusTitle.textContent = "No active tab";
            statusDescription.textContent = "Unable to identify the current tab.";
            resetCourseAndMaterials();
            return;
        }

        // Without broad 'tabs' permission, tab.url is populated only for host_permissions (vtop.vit.ac.in)
        if (!currentTab.url) {
            statusTitle.textContent = "VTOP not detected";
            statusDescription.textContent = "Open https://vtop.vit.ac.in to use the organizer.";
            resetCourseAndMaterials();
            return;
        }

        const currentUrl = new URL(currentTab.url);
        if (currentUrl.hostname !== "vtop.vit.ac.in") {
            statusTitle.textContent = "VTOP not detected";
            statusDescription.textContent = "Open https://vtop.vit.ac.in to use the organizer.";
            resetCourseAndMaterials();
            return;
        }

        let pageState = await sendTabMessageWithRecovery(currentTab.id, {
            type: "GET_VTOP_PAGE_STATE"
        });

        if (pageState && pageState.ok && pageState.detectorVersion !== 2) {
            await ensureContentScriptsInjected(currentTab.id);
            pageState = await chrome.tabs.sendMessage(currentTab.id, {
                type: "GET_VTOP_PAGE_STATE"
            });
        }

        if (!pageState || !pageState.ok) {
            statusTitle.textContent = "VTOP detected";
            statusDescription.textContent = "Unable to inspect page state. Try refreshing VTOP.";
            resetCourseAndMaterials();
            return;
        }

        if (!pageState.isCourseMaterialPage) {
            statusTitle.textContent = "VTOP detected";
            statusDescription.textContent = "Navigate to Course Page Consolidated to scan materials.";
            resetCourseAndMaterials("Waiting for VTOP Course Page Consolidated (#materialTable).");
            return;
        }

        statusTitle.textContent = "Course Page detected";
        statusDescription.textContent = "Extracting material list from DataTables...";

        const extraction = await sendTabMessageWithRecovery(currentTab.id, {
            type: "EXTRACT_COURSE_MATERIALS"
        });

        if (!extraction || !extraction.ok) {
            statusTitle.textContent = "Extraction issue";
            statusDescription.textContent = "Course page detected, but extraction failed.";
            resetCourseAndMaterials("Extraction failed.");
            showFeedback(
                materialsErrorEl,
                extraction?.error || "Failed to extract material records.",
                true
            );
            return;
        }

        statusTitle.textContent = "Course Page ready";
        statusDescription.textContent = `Extracted ${extraction.materials.length} material record(s).`;
        renderMaterials(extraction);
    } catch (error) {
        statusTitle.textContent = "Connection error";
        statusDescription.textContent = "Could not communicate with the active tab.";
        showFeedback(
            materialsErrorEl,
            error instanceof Error ? error.message : "Unexpected error communicating with tab.",
            true
        );
    }
}

async function restoreSavedDirectory() {
    try {
        const handle = await loadDirectoryHandle();
        if (!handle) {
            state.dirHandle = null;
            state.dirPermission = "none";
            renderFolderState();
            return;
        }
        const permission = await verifyDirectoryPermission(handle, { requestIfPrompt: false });
        state.dirHandle = handle;
        state.dirPermission = permission;
        renderFolderState();
    } catch (error) {
        showFeedback(
            fsFeedbackEl,
            error instanceof Error ? error.message : "Failed to restore saved directory.",
            true
        );
    }
}

async function restoreOrganizationMode() {
    try {
        if (!chrome?.storage?.local) {
            return;
        }
        const stored = await chrome.storage.local.get(ORG_MODE_STORAGE_KEY);
        const mode = stored?.[ORG_MODE_STORAGE_KEY];
        if (mode === ORGANIZATION_MODES.COURSE_FACULTY || mode === ORGANIZATION_MODES.COURSE_ONLY) {
            organizationModeSelect.value = mode;
        }
    } catch {
        // Ignore storage read errors and retain default mode
    }
}

organizationModeSelect.addEventListener("change", () => {
    const mode = organizationModeSelect.value;
    if (chrome?.storage?.local) {
        chrome.storage.local.set({ [ORG_MODE_STORAGE_KEY]: mode }).catch(() => {});
    }
});

// Keep showDirectoryPicker() synchronous inside click handler before any await
chooseFolderButton.addEventListener("click", () => {
    hideElement(fsFeedbackEl);
    pickAndSaveDirectory()
        .then(({ handle, permission }) => {
            state.dirHandle = handle;
            state.dirPermission = permission;
            renderFolderState();
            showFeedback(fsFeedbackEl, `Selected folder "${handle.name}" (${permission}).`);
        })
        .catch((error) => {
            if (error?.name === "AbortError") {
                return;
            }
            showFeedback(
                fsFeedbackEl,
                error instanceof Error ? error.message : "Directory selection failed.",
                true
            );
        });
});

reauthorizeFolderButton.addEventListener("click", () => {
    if (!state.dirHandle) {
        return;
    }
    hideElement(fsFeedbackEl);
    requestDirectoryPermission(state.dirHandle)
        .then((permission) => {
            state.dirPermission = permission;
            renderFolderState();
            showFeedback(
                fsFeedbackEl,
                permission === "granted"
                    ? `Permission granted for "${state.dirHandle.name}".`
                    : `Permission state: ${permission}.`,
                permission !== "granted"
            );
        })
        .catch((error) => {
            showFeedback(
                fsFeedbackEl,
                error instanceof Error ? error.message : "Re-authorization failed.",
                true
            );
        });
});

testFileButton.addEventListener("click", async () => {
    if (!state.dirHandle) {
        return;
    }
    hideElement(fsFeedbackEl);
    try {
        const result = await createStage2TestFile(state.dirHandle);
        showFeedback(
            fsFeedbackEl,
            `Wrote ${result.testFolder}/${result.fileName} (${result.size} bytes) inside "${result.folderName}".`
        );
    } catch (error) {
        showFeedback(
            fsFeedbackEl,
            error instanceof Error ? error.message : "Failed to write test file.",
            true
        );
    }
});

startDownloadButton.addEventListener("click", async () => {
    if (state.queueRunning || !state.extraction?.ok || !state.dirHandle) {
        return;
    }
    hideElement(materialsErrorEl);

    const organizationMode =
        organizationModeSelect.value === ORGANIZATION_MODES.COURSE_ONLY
            ? ORGANIZATION_MODES.COURSE_ONLY
            : ORGANIZATION_MODES.COURSE_FACULTY;

    const loadRes = queueManager.loadQueue(state.extraction.materials, {
        course: state.extraction.course,
        organizationMode,
        formAction: state.extraction.formAction,
        formEntries: state.extraction.formEntries
    });

    if (!loadRes.ok) {
        showFeedback(materialsErrorEl, loadRes.error || "Unable to prepare download queue.", true);
        return;
    }

    renderQueueSnapshotProgress(loadRes.snapshot);
    try {
        const runRes = await queueManager.start();
        if (!runRes.ok) {
            showFeedback(materialsErrorEl, runRes.error || "Download queue stopped due to an error.", true);
        }
    } finally {
        state.queueRunning = false;
        updateDownloadControlState();
    }
});

refreshButton.addEventListener("click", checkCurrentWebsite);

chrome.tabs.onActivated.addListener(() => {
    checkCurrentWebsite();
});

restoreOrganizationMode();
restoreSavedDirectory();
checkCurrentWebsite();
