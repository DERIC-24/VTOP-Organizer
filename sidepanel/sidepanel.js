import {
    ensureSubdirectory,
    loadDirectoryHandle,
    pickAndSaveDirectory,
    requestDirectoryPermission,
    verifyDirectoryPermission,
    writeBinaryFile
} from "../services/file-system.js";
import { downloadMaterial } from "../services/download-service.js";
import { MATERIAL_STATES, QUEUE_STATES } from "../services/download-state.js";
import {
    createFileSystemSaveAdapter,
    DownloadQueueManager,
    getAll404SessionWarning,
    getAuthExpiredWarning,
    ORGANIZATION_MODES,
    QUEUE_EVENTS
} from "../services/queue-manager.js";
import {
    buildAllDownloadPayload,
    buildSelectedDownloadPayload,
    countSelectedMaterials,
    deselectAllMaterials,
    isSelectableMaterial,
    prepareSelectableMaterials,
    selectAllMaterials,
    toggleMaterialSelection
} from "../utils/material-selection.js";

const ORG_MODE_STORAGE_KEY = "vtop_organizer_org_mode";

const statusTitle = document.getElementById("status-title");
const statusDescription = document.getElementById("status-description");
const refreshButton = document.getElementById("refresh-button");

const folderNameEl = document.getElementById("folder-name");
const folderStatusEl = document.getElementById("folder-status");
const chooseFolderButton = document.getElementById("choose-folder-button");
const reauthorizeFolderButton = document.getElementById("reauthorize-folder-button");
const fsFeedbackEl = document.getElementById("fs-feedback");

const courseNameEl = document.getElementById("course-name");
const courseCodeEl = document.getElementById("course-code");

const materialsBadgeEl = document.getElementById("materials-badge");
const materialsSummaryEl = document.getElementById("materials-summary");
const materialsErrorEl = document.getElementById("materials-error");
const materialsListEl = document.getElementById("materials-list");

const organizationModeSelect = document.getElementById("organization-mode");
const selectionToolbarEl = document.getElementById("selection-toolbar");
const selectAllButton = document.getElementById("select-all-button");
const deselectAllButton = document.getElementById("deselect-all-button");
const selectionCountEl = document.getElementById("selection-count");
const downloadSelectedButton = document.getElementById("download-selected-button");
const startDownloadButton = document.getElementById("start-download-button");
const queueActionRowEl = document.getElementById("queue-action-row");
const pauseQueueButton = document.getElementById("pause-queue-button");
const resumeQueueButton = document.getElementById("resume-queue-button");
const cancelQueueButton = document.getElementById("cancel-queue-button");
const retryFailedButton = document.getElementById("retry-failed-button");

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
    materials: [],
    selectedIds: new Set(),
    queueRunning: false,
    queueSnapshot: null,
    itemStatusEls: new Map(),
    itemRowEls: new Map(),
    itemCheckboxes: new Map()
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

const STATUS_CLASS_NAMES = [
    "status-selected",
    "status-pending",
    "status-downloading",
    "status-retrying",
    "status-completed",
    "status-failed",
    "status-cancelled",
    "status-skipped"
];

const ROW_STATE_CLASS_NAMES = [
    "is-selected",
    "state-pending",
    "state-downloading",
    "state-retrying",
    "state-completed",
    "state-failed",
    "state-cancelled",
    "state-skipped"
];

function isQueueBusy() {
    const qState = state.queueSnapshot?.queueState;
    return (
        state.queueRunning ||
        qState === QUEUE_STATES.RUNNING ||
        qState === QUEUE_STATES.PAUSED ||
        qState === QUEUE_STATES.CANCELLING
    );
}

function setMaterialItemStatus(materialId, text, statusKey = "") {
    const tag = state.itemStatusEls.get(materialId);
    if (tag) {
        tag.textContent = text;
        tag.classList.remove(...STATUS_CLASS_NAMES);
        if (statusKey) {
            tag.classList.add(`status-${statusKey}`);
        }
    }

    const row = state.itemRowEls.get(materialId);
    if (row) {
        row.classList.remove(...ROW_STATE_CLASS_NAMES);
        if (statusKey === "selected") {
            row.classList.add("is-selected");
        } else if (statusKey) {
            row.classList.add(`state-${statusKey}`);
            if (state.selectedIds.has(materialId)) {
                row.classList.add("is-selected");
            }
        }
    }
}

function getDefaultBadgeText(item) {
    return item.hasValidFileId ? `ID: ${item.fileId}` : "No ID";
}

function syncSelectionUI() {
    const selectableCount = state.materials.filter(isSelectableMaterial).length;
    const selectedCount = countSelectedMaterials(state.materials, state.selectedIds);
    selectionCountEl.textContent = `${selectedCount} / ${selectableCount} selected`;

    const snapshot = state.queueSnapshot;
    const activeSnapshotById = new Map(
        Array.isArray(snapshot?.items) ? snapshot.items.map((item) => [item.id, item]) : []
    );

    for (const item of state.materials) {
        const checkbox = state.itemCheckboxes.get(item.id);
        const isSelected = state.selectedIds.has(item.id);
        if (checkbox) {
            checkbox.checked = isSelected;
            checkbox.disabled = isQueueBusy() || !isSelectableMaterial(item);
        }

        const queueItem = activeSnapshotById.get(item.id);
        if (!queueItem) {
            setMaterialItemStatus(
                item.id,
                isSelected ? "Selected" : getDefaultBadgeText(item),
                isSelected ? "selected" : ""
            );
        }
    }

    updateDownloadControlState();
}

function syncAllItemsFromSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) {
        return;
    }

    const byId = new Map(snapshot.items.map((item) => [item.id, item]));
    const isPaused = snapshot.queueState === QUEUE_STATES.PAUSED;

    for (const item of state.materials) {
        const qItem = byId.get(item.id);
        if (!qItem) {
            const isSelected = state.selectedIds.has(item.id);
            setMaterialItemStatus(
                item.id,
                isSelected ? "Selected" : getDefaultBadgeText(item),
                isSelected ? "selected" : ""
            );
            continue;
        }

        if (qItem.state === MATERIAL_STATES.PENDING) {
            setMaterialItemStatus(item.id, isPaused ? "Paused" : "Pending", "pending");
        } else if (qItem.state === MATERIAL_STATES.DOWNLOADING) {
            const pct = qItem.progress && !qItem.progress.indeterminate ? `${qItem.progress.percent}%` : null;
            setMaterialItemStatus(
                item.id,
                pct || `Downloading (${qItem.attempts})`,
                "downloading"
            );
        } else if (qItem.state === MATERIAL_STATES.RETRYING) {
            setMaterialItemStatus(item.id, `Retrying (${qItem.attempts})`, "retrying");
        } else if (qItem.state === MATERIAL_STATES.COMPLETED) {
            setMaterialItemStatus(item.id, `Saved: ${qItem.savedFilename}`, "completed");
        } else if (qItem.state === MATERIAL_STATES.FAILED) {
            setMaterialItemStatus(
                item.id,
                `Failed (${qItem.error?.code || "ERROR"})`,
                "failed"
            );
        } else if (qItem.state === MATERIAL_STATES.CANCELLED) {
            setMaterialItemStatus(item.id, "Cancelled", "cancelled");
        } else if (qItem.state === MATERIAL_STATES.SKIPPED) {
            setMaterialItemStatus(item.id, "Skipped", "skipped");
        }
    }
}

function updateDownloadControlState() {
    const busy = isQueueBusy();
    const selectableCount = state.materials.filter(isSelectableMaterial).length;
    const hasForm = Boolean(state.extraction?.ok && state.extraction?.formAvailable);
    const hasMaterials = hasForm && selectableCount > 0;
    const selectedCount = countSelectedMaterials(state.materials, state.selectedIds);
    const hasWritePermission = Boolean(state.dirHandle && state.dirPermission === "granted");

    const qState = state.queueSnapshot?.queueState || QUEUE_STATES.IDLE;
    const canPause = Boolean(state.queueSnapshot?.canPause);
    const canResume = Boolean(state.queueSnapshot?.canResume);
    const canCancel = Boolean(state.queueSnapshot?.canCancel);
    const canRetryFailed = Boolean(state.queueSnapshot?.canRetryFailed && !busy && hasForm && hasWritePermission);

    selectionToolbarEl.classList.toggle("hidden", state.materials.length === 0);
    selectAllButton.disabled = busy || !hasMaterials || selectedCount === selectableCount;
    deselectAllButton.disabled = busy || selectedCount === 0;

    downloadSelectedButton.disabled = busy || !hasMaterials || selectedCount === 0 || !hasWritePermission;
    startDownloadButton.disabled = busy || !hasMaterials || !hasWritePermission;

    const showActionRow =
        qState === QUEUE_STATES.RUNNING ||
        qState === QUEUE_STATES.PAUSED ||
        qState === QUEUE_STATES.CANCELLING ||
        Boolean(state.queueSnapshot?.canRetryFailed);
    queueActionRowEl.classList.toggle("hidden", !showActionRow);

    pauseQueueButton.classList.toggle(
        "hidden",
        qState !== QUEUE_STATES.RUNNING && qState !== QUEUE_STATES.CANCELLING
    );
    pauseQueueButton.disabled = !canPause;

    resumeQueueButton.classList.toggle("hidden", qState !== QUEUE_STATES.PAUSED);
    resumeQueueButton.disabled = !canResume;

    cancelQueueButton.classList.toggle(
        "hidden",
        qState !== QUEUE_STATES.RUNNING &&
            qState !== QUEUE_STATES.PAUSED &&
            qState !== QUEUE_STATES.CANCELLING
    );
    cancelQueueButton.disabled = !canCancel;

    retryFailedButton.classList.toggle("hidden", !state.queueSnapshot?.canRetryFailed);
    retryFailedButton.disabled = !canRetryFailed;

    for (const item of state.materials) {
        const checkbox = state.itemCheckboxes.get(item.id);
        if (checkbox) {
            checkbox.disabled = busy || !isSelectableMaterial(item);
        }
    }

    organizationModeSelect.disabled = busy;
    refreshButton.disabled = busy;
    chooseFolderButton.disabled = busy;
    reauthorizeFolderButton.disabled = busy;
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
    if (snapshot.cancelled > 0) {
        summaryParts.push(`${snapshot.cancelled} cancelled`);
    }
    if (snapshot.skipped > 0) {
        summaryParts.push(`${snapshot.skipped} skipped`);
    }

    const prefix =
        snapshot.queueState === QUEUE_STATES.PAUSED
            ? "Paused"
            : snapshot.queueState === QUEUE_STATES.CANCELLING
              ? "Cancelling"
              : "Queue";
    queueProgressText.textContent = `${prefix}: ${summaryParts.join(" · ")}`;
}

function renderActiveFileProgress({ topic, attempt, maxAttempts, progress, isManualRetry = false }) {
    if (!progress) {
        return;
    }
    const retryTag = isManualRetry ? " [Manual Retry]" : "";
    const prefix = attempt ? `${topic}${retryTag} (Attempt ${attempt}/${maxAttempts})` : topic;

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

function handleQueueEvent(event) {
    const { type, snapshot } = event;
    state.queueSnapshot = snapshot;
    renderQueueSnapshotProgress(snapshot);

    if (type === QUEUE_EVENTS.QUEUE_STARTED) {
        state.queueRunning = true;
        syncAllItemsFromSnapshot(snapshot);
        updateDownloadControlState();
        fileProgressBar.removeAttribute("value");
        fileProgressText.textContent = event.isManualRetry
            ? "Retrying failed materials sequentially..."
            : "Starting sequential downloads...";
        fileProgressPercent.textContent = "";
        return;
    }

    if (type === QUEUE_EVENTS.QUEUE_PAUSED) {
        state.queueRunning = true;
        syncAllItemsFromSnapshot(snapshot);
        updateDownloadControlState();
        fileProgressBar.max = 100;
        fileProgressBar.value = 0;
        fileProgressText.textContent = "Paused — click Resume to restart current file or Cancel to stop.";
        fileProgressPercent.textContent = "Paused";
        return;
    }

    if (type === QUEUE_EVENTS.QUEUE_RESUMED) {
        state.queueRunning = true;
        syncAllItemsFromSnapshot(snapshot);
        updateDownloadControlState();
        fileProgressBar.removeAttribute("value");
        fileProgressText.textContent = "Resuming sequential downloads...";
        fileProgressPercent.textContent = "";
        return;
    }

    if (type === QUEUE_EVENTS.QUEUE_CANCELLING) {
        state.queueRunning = true;
        updateDownloadControlState();
        fileProgressText.textContent = "Cancelling downloads...";
        fileProgressPercent.textContent = "Cancelling";
        return;
    }

    if (type === QUEUE_EVENTS.QUEUE_CANCELLED) {
        syncAllItemsFromSnapshot(snapshot);
        return;
    }

    if (type === QUEUE_EVENTS.MATERIAL_ATTEMPT_STARTED) {
        const retryLabel = event.isManualRetry ? "Retry " : "";
        setMaterialItemStatus(
            event.materialId,
            `${retryLabel}Downloading (${event.attempt}/${event.maxAttempts})`,
            "downloading"
        );
        renderActiveFileProgress({
            topic: event.topic,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            isManualRetry: event.isManualRetry,
            progress: { bytesReceived: 0, totalBytes: null, percent: null, indeterminate: true }
        });
        return;
    }

    if (type === QUEUE_EVENTS.MATERIAL_PROGRESS) {
        renderActiveFileProgress({
            topic: event.topic,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            isManualRetry: event.isManualRetry,
            progress: event.progress
        });
        if (!event.progress.indeterminate) {
            setMaterialItemStatus(event.materialId, `${event.progress.percent}%`, "downloading");
        } else {
            setMaterialItemStatus(
                event.materialId,
                formatBytes(event.progress.bytesReceived),
                "downloading"
            );
        }
        return;
    }

    if (type === QUEUE_EVENTS.MATERIAL_STATE_CHANGED) {
        if (event.state === MATERIAL_STATES.PENDING) {
            setMaterialItemStatus(event.materialId, "Paused", "pending");
        } else if (event.state === MATERIAL_STATES.RETRYING) {
            setMaterialItemStatus(event.materialId, `Retrying (${event.attempts})`, "retrying");
        } else if (event.state === MATERIAL_STATES.FAILED) {
            setMaterialItemStatus(
                event.materialId,
                `Failed (${event.error?.code || "ERROR"})`,
                "failed"
            );
        } else if (event.state === MATERIAL_STATES.CANCELLED) {
            setMaterialItemStatus(event.materialId, "Cancelled", "cancelled");
        } else if (event.state === MATERIAL_STATES.SKIPPED) {
            setMaterialItemStatus(event.materialId, "Skipped", "skipped");
        }
        return;
    }

    if (type === QUEUE_EVENTS.MATERIAL_COMPLETED) {
        setMaterialItemStatus(event.materialId, `Saved: ${event.savedFilename}`, "completed");
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
        syncAllItemsFromSnapshot(snapshot);
        updateDownloadControlState();

        if (type === QUEUE_EVENTS.QUEUE_COMPLETED) {
            fileProgressText.textContent = `All ${snapshot.completed} file(s) downloaded and saved.`;
            fileProgressPercent.textContent = "Done";
        } else if (snapshot.cancelled > 0) {
            fileProgressText.textContent = `Cancelled: ${snapshot.completed} saved, ${snapshot.cancelled} cancelled${
                snapshot.failed > 0 ? `, ${snapshot.failed} failed` : ""
            }.`;
            fileProgressPercent.textContent = "Cancelled";
        } else {
            fileProgressText.textContent = `Finished: ${snapshot.completed} saved, ${snapshot.failed} failed.`;
            fileProgressPercent.textContent = "Done";
        }

        fileProgressBar.max = 100;
        fileProgressBar.value = 100;

        if (type === QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS) {
            const authWarning = getAuthExpiredWarning(snapshot);
            if (authWarning) {
                showFeedback(materialsErrorEl, authWarning, true);
            } else {
                const warning = getAll404SessionWarning(snapshot, type);
                if (warning) {
                    showFeedback(materialsErrorEl, warning, true);
                }
            }
        }
    }
}

function resetCourseAndMaterials(summaryText = "Open Course Page Consolidated and click Refresh & Scan Course.") {
    state.extraction = null;
    state.materials = [];
    state.selectedIds = new Set();
    state.queueSnapshot = null;
    state.itemStatusEls.clear();
    state.itemRowEls.clear();
    state.itemCheckboxes.clear();
    courseNameEl.textContent = "No course detected";
    courseCodeEl.textContent = "Waiting for VTOP course page";
    materialsBadgeEl.textContent = "0";
    materialsSummaryEl.textContent = summaryText;
    selectionCountEl.textContent = "0 / 0 selected";
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
    state.queueSnapshot = null;
    state.selectedIds = new Set();
    state.itemStatusEls.clear();
    state.itemRowEls.clear();
    state.itemCheckboxes.clear();

    const course = extraction.course || {};
    courseNameEl.textContent = course.courseName || "Unknown Course";
    if (course.courseCode && course.courseType) {
        courseCodeEl.textContent = `${course.courseCode} · ${course.courseType}`;
    } else {
        courseCodeEl.textContent = course.courseType || course.courseCode || "Course code unavailable";
    }

    const rawMaterials = Array.isArray(extraction.materials) ? extraction.materials : [];
    const materials = prepareSelectableMaterials(rawMaterials, course);
    state.materials = materials;

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

    queueProgressBox.classList.add("hidden");
    materialsListEl.innerHTML = "";
    if (materials.length === 0) {
        materialsListEl.classList.add("hidden");
        syncSelectionUI();
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of materials) {
        const li = document.createElement("li");
        li.className = "material-item";

        const row = document.createElement("div");
        row.className = "material-item-row";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "material-checkbox";
        checkbox.disabled = !isSelectableMaterial(item);
        checkbox.setAttribute("aria-label", `Select ${item.topic}`);
        checkbox.addEventListener("change", () => {
            if (isQueueBusy()) {
                checkbox.checked = state.selectedIds.has(item.id);
                return;
            }
            state.selectedIds = toggleMaterialSelection(
                state.materials,
                state.selectedIds,
                item.id,
                checkbox.checked
            );
            syncSelectionUI();
        });

        const content = document.createElement("div");
        content.className = "material-content";

        const title = document.createElement("div");
        title.className = "material-title";
        title.textContent = `${item.rowNumber}. ${item.topic}`;

        const meta = document.createElement("div");
        meta.className = "material-meta";

        const faculty = document.createElement("span");
        faculty.textContent = item.uploadedBy || "Unknown faculty";

        const fileTag = document.createElement("span");
        fileTag.className = "file-id-tag";
        fileTag.textContent = getDefaultBadgeText(item);

        state.itemRowEls.set(item.id, li);
        state.itemStatusEls.set(item.id, fileTag);
        state.itemCheckboxes.set(item.id, checkbox);

        meta.append(faculty, fileTag);
        content.append(title, meta);
        row.append(checkbox, content);
        li.append(row);
        fragment.appendChild(li);
    }

    materialsListEl.appendChild(fragment);
    materialsListEl.classList.remove("hidden");
    syncSelectionUI();
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
    if (isQueueBusy()) {
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

function getSelectedOrganizationMode() {
    return organizationModeSelect.value === ORGANIZATION_MODES.COURSE_ONLY
        ? ORGANIZATION_MODES.COURSE_ONLY
        : ORGANIZATION_MODES.COURSE_FACULTY;
}

async function runQueueDownload(materialsToQueue) {
    if (isQueueBusy() || !state.extraction?.ok || !state.dirHandle) {
        return;
    }
    hideElement(materialsErrorEl);
    state.queueRunning = true;
    updateDownloadControlState();

    const loadRes = queueManager.loadQueue(materialsToQueue, {
        course: state.extraction.course,
        organizationMode: getSelectedOrganizationMode(),
        formAction: state.extraction.formAction,
        formEntries: state.extraction.formEntries
    });

    if (!loadRes.ok) {
        state.queueRunning = false;
        showFeedback(materialsErrorEl, loadRes.error || "Unable to prepare download queue.", true);
        updateDownloadControlState();
        return;
    }

    state.queueSnapshot = loadRes.snapshot;
    syncAllItemsFromSnapshot(loadRes.snapshot);
    renderQueueSnapshotProgress(loadRes.snapshot);

    try {
        const runRes = await queueManager.start();
        state.queueSnapshot = runRes.snapshot || queueManager.getSnapshot();
        if (!runRes.ok) {
            showFeedback(materialsErrorEl, runRes.error || "Download queue stopped due to an error.", true);
        }
    } finally {
        state.queueRunning = false;
        syncAllItemsFromSnapshot(state.queueSnapshot);
        updateDownloadControlState();
    }
}

selectAllButton.addEventListener("click", () => {
    if (isQueueBusy() || state.materials.length === 0) {
        return;
    }
    state.selectedIds = selectAllMaterials(state.materials);
    syncSelectionUI();
});

deselectAllButton.addEventListener("click", () => {
    if (isQueueBusy() || state.selectedIds.size === 0) {
        return;
    }
    state.selectedIds = deselectAllMaterials();
    syncSelectionUI();
});

downloadSelectedButton.addEventListener("click", async () => {
    if (isQueueBusy() || !state.extraction?.ok || !state.dirHandle) {
        return;
    }
    const selectedMaterials = buildSelectedDownloadPayload(
        state.materials,
        state.selectedIds,
        state.extraction.course
    );
    if (selectedMaterials.length === 0) {
        showFeedback(materialsErrorEl, "Select at least one material with a valid file ID.", true);
        return;
    }
    await runQueueDownload(selectedMaterials);
});

startDownloadButton.addEventListener("click", async () => {
    if (isQueueBusy() || !state.extraction?.ok || !state.dirHandle) {
        return;
    }
    const allMaterials = buildAllDownloadPayload(state.materials, state.extraction.course);
    await runQueueDownload(allMaterials);
});

pauseQueueButton.addEventListener("click", async () => {
    if (!state.queueSnapshot?.canPause) {
        return;
    }
    pauseQueueButton.disabled = true;
    const res = await queueManager.pause();
    if (res.snapshot) {
        state.queueSnapshot = res.snapshot;
    }
    if (!res.ok) {
        showFeedback(materialsErrorEl, res.error || "Unable to pause queue.", true);
    }
    updateDownloadControlState();
});

resumeQueueButton.addEventListener("click", async () => {
    if (!state.queueSnapshot?.canResume) {
        return;
    }
    hideElement(materialsErrorEl);
    resumeQueueButton.disabled = true;
    state.queueRunning = true;
    updateDownloadControlState();

    try {
        const res = await queueManager.resume();
        state.queueSnapshot = res.snapshot || queueManager.getSnapshot();
        if (!res.ok) {
            showFeedback(materialsErrorEl, res.error || "Unable to resume queue.", true);
        }
    } finally {
        state.queueRunning = false;
        syncAllItemsFromSnapshot(state.queueSnapshot);
        updateDownloadControlState();
    }
});

cancelQueueButton.addEventListener("click", async () => {
    if (!state.queueSnapshot?.canCancel) {
        return;
    }
    cancelQueueButton.disabled = true;
    pauseQueueButton.disabled = true;
    resumeQueueButton.disabled = true;
    const res = await queueManager.cancel();
    state.queueSnapshot = res.snapshot || queueManager.getSnapshot();
    if (!res.ok) {
        showFeedback(materialsErrorEl, res.error || "Unable to cancel queue.", true);
    }
    state.queueRunning = false;
    syncAllItemsFromSnapshot(state.queueSnapshot);
    updateDownloadControlState();
});

retryFailedButton.addEventListener("click", async () => {
    if (isQueueBusy() || !state.queueSnapshot?.canRetryFailed || !state.dirHandle) {
        return;
    }
    hideElement(materialsErrorEl);
    state.queueRunning = true;
    updateDownloadControlState();

    try {
        const res = await queueManager.retryFailed();
        state.queueSnapshot = res.snapshot || queueManager.getSnapshot();
        if (!res.ok) {
            showFeedback(materialsErrorEl, res.error || "Unable to retry failed materials.", true);
        }
    } finally {
        state.queueRunning = false;
        syncAllItemsFromSnapshot(state.queueSnapshot);
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
