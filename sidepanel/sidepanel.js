import {
    createStage2TestFile,
    loadDirectoryHandle,
    pickAndSaveDirectory,
    requestDirectoryPermission,
    verifyDirectoryPermission
} from "../services/file-system.js";
import { downloadMaterial } from "../services/download-service.js";

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

const state = {
    dirHandle: null,
    dirPermission: "none",
    extraction: null
};

// Expose Stage 2 services on window for controlled console inspection without storing secrets
globalThis.__vtopOrganizerStage2 = {
    downloadMaterial
};

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

function resetCourseAndMaterials(summaryText = "Open Course Page Consolidated and click Refresh & Scan Course.") {
    state.extraction = null;
    courseNameEl.textContent = "No course detected";
    courseCodeEl.textContent = "Waiting for VTOP course page";
    materialsBadgeEl.textContent = "0";
    materialsSummaryEl.textContent = summaryText;
    hideElement(materialsErrorEl);
    materialsListEl.innerHTML = "";
    materialsListEl.classList.add("hidden");
}

function renderFolderState() {
    if (!state.dirHandle) {
        folderNameEl.textContent = "No folder selected";
        folderStatusEl.textContent = "Choose a folder to store course materials.";
        reauthorizeFolderButton.classList.add("hidden");
        testFileButton.disabled = true;
        return;
    }

    folderNameEl.textContent = state.dirHandle.name;

    if (state.dirPermission === "granted") {
        folderStatusEl.textContent = "Write access granted (persisted in IndexedDB).";
        reauthorizeFolderButton.classList.add("hidden");
        testFileButton.disabled = false;
    } else if (state.dirPermission === "prompt") {
        folderStatusEl.textContent = "Saved folder requires re-authorization after reload.";
        reauthorizeFolderButton.classList.remove("hidden");
        testFileButton.disabled = true;
    } else {
        folderStatusEl.textContent = "Folder permission denied. Please choose a folder again.";
        reauthorizeFolderButton.classList.add("hidden");
        testFileButton.disabled = true;
    }
}

function renderMaterials(extraction) {
    state.extraction = extraction;

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

        meta.append(faculty, fileTag);
        li.append(title, meta);
        fragment.appendChild(li);
    }

    materialsListEl.appendChild(fragment);
    materialsListEl.classList.remove("hidden");
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

refreshButton.addEventListener("click", checkCurrentWebsite);

chrome.tabs.onActivated.addListener(() => {
    checkCurrentWebsite();
});

restoreSavedDirectory();
checkCurrentWebsite();
