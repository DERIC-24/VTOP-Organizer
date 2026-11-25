import { buildTargetFolderSegments } from "../utils/folder-organizer.js";
import {
    classifyDownloadError,
    ERROR_CATEGORIES,
    MAX_DOWNLOAD_ATTEMPTS,
    shouldRetryAttempt
} from "./download-errors.js";
import {
    computeFinalQueueState,
    MATERIAL_STATES,
    QUEUE_STATES,
    transitionMaterialState,
    transitionQueueState
} from "./download-state.js";

export const ORGANIZATION_MODES = Object.freeze({
    COURSE_FACULTY: "course_faculty",
    COURSE_ONLY: "course_only"
});

export const QUEUE_EVENTS = Object.freeze({
    QUEUE_STARTED: "queue:started",
    QUEUE_COMPLETED: "queue:completed",
    QUEUE_COMPLETED_WITH_ERRORS: "queue:completed_with_errors",
    MATERIAL_STATE_CHANGED: "material:state_changed",
    MATERIAL_ATTEMPT_STARTED: "material:attempt_started",
    MATERIAL_PROGRESS: "material:progress",
    MATERIAL_ATTEMPT_FAILED: "material:attempt_failed",
    MATERIAL_COMPLETED: "material:completed"
});

export const ALL_404_SESSION_WARNING =
    "VTOP returned 404 for all attempted materials. Refresh your VTOP session, then use Refresh & Scan Course before trying again.";

export function getAll404SessionWarning(snapshot, eventType = QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS) {
    if (
        eventType !== QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS ||
        !snapshot ||
        snapshot.queueState !== QUEUE_STATES.COMPLETED_WITH_ERRORS
    ) {
        return null;
    }

    if (snapshot.cancelled > 0 || snapshot.completed !== 0 || snapshot.failed < 1) {
        return null;
    }

    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    const failedItems = items.filter((item) => item.state === MATERIAL_STATES.FAILED);
    if (failedItems.length !== snapshot.failed || failedItems.length === 0) {
        return null;
    }

    const allNotFound = failedItems.every(
        (item) => item.error?.category === ERROR_CATEGORIES.NOT_FOUND
    );
    return allNotFound ? ALL_404_SESSION_WARNING : null;
}

const VALID_ORGANIZATION_MODES = new Set(Object.values(ORGANIZATION_MODES));
const MAX_RETRY_DELAY_MS = 30000;

function defaultDelay(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return Promise.resolve();
    }
    const boundedMs = Math.min(MAX_RETRY_DELAY_MS, ms);
    return new Promise((resolve) => setTimeout(resolve, boundedMs));
}

function defaultRetryDelayMs(attemptNumber) {
    return Math.min(2000, 250 * attemptNumber);
}

function normalizeText(value, fallback = "") {
    if (typeof value !== "string") {
        return fallback;
    }
    const trimmed = value.trim();
    return trimmed || fallback;
}

function createMaterialIdentifier(rawItem, index) {
    const explicitId = normalizeText(rawItem?.id, "");
    if (explicitId) {
        return explicitId;
    }
    const fileId = normalizeText(rawItem?.fileId, "");
    if (fileId) {
        return fileId;
    }
    return `item-${index + 1}`;
}

function normalizeMaterialRecord(rawItem, index, defaultCourse, organizationMode) {
    const fileId = normalizeText(rawItem?.fileId, "");
    const courseCode = normalizeText(rawItem?.courseCode || defaultCourse?.courseCode, "");
    const courseName = normalizeText(rawItem?.courseName || defaultCourse?.courseName, "Unknown Course");
    const facultyName = normalizeText(rawItem?.facultyName || rawItem?.uploadedBy, "Unknown Faculty");
    const topic = normalizeText(rawItem?.topic || rawItem?.title, `Material ${index + 1}`);
    const fileType = normalizeText(rawItem?.fileType || rawItem?.component, "");
    const rawFilename = normalizeText(rawItem?.rawFilename || rawItem?.filename, "");
    const id = createMaterialIdentifier(rawItem, index);

    return {
        id,
        fileId,
        topic,
        courseCode,
        courseName,
        facultyName,
        fileType,
        rawFilename,
        organizationMode,
        state: MATERIAL_STATES.PENDING,
        attempts: 0,
        progress: null,
        error: null,
        skipReason: null,
        savedFilename: null,
        savedPath: null,
        byteLength: null
    };
}

function normalizeProgress(rawProgress) {
    if (!rawProgress || typeof rawProgress !== "object") {
        return null;
    }
    const bytesReceived =
        Number.isFinite(rawProgress.bytesReceived) && rawProgress.bytesReceived >= 0
            ? rawProgress.bytesReceived
            : 0;
    const totalBytes =
        Number.isSafeInteger(rawProgress.totalBytes) && rawProgress.totalBytes > 0
            ? rawProgress.totalBytes
            : null;
    const indeterminate = totalBytes === null;
    const percent =
        totalBytes !== null
            ? Math.min(100, Math.round((bytesReceived / totalBytes) * 100))
            : null;

    return {
        bytesReceived,
        totalBytes,
        percent,
        indeterminate
    };
}

function clonePublicMaterial(item) {
    return {
        id: item.id,
        fileId: item.fileId,
        topic: item.topic,
        courseCode: item.courseCode,
        courseName: item.courseName,
        facultyName: item.facultyName,
        fileType: item.fileType,
        rawFilename: item.rawFilename,
        organizationMode: item.organizationMode,
        state: item.state,
        attempts: item.attempts,
        progress: item.progress ? { ...item.progress } : null,
        error: item.error ? { ...item.error } : null,
        skipReason: item.skipReason,
        savedFilename: item.savedFilename,
        savedPath: item.savedPath,
        byteLength: item.byteLength
    };
}

function validateAndCloneFormEntries(formEntries) {
    if (formEntries === undefined) {
        return { ok: true, entries: [] };
    }
    if (!Array.isArray(formEntries)) {
        return {
            ok: false,
            code: "INVALID_FORM_ENTRIES",
            error: "Form metadata entries must be an array of [name, value] tuples."
        };
    }

    const sanitized = [];
    for (const entry of formEntries) {
        if (!Array.isArray(entry) || entry.length < 2) {
            return {
                ok: false,
                code: "INVALID_FORM_ENTRIES",
                error: "Form metadata contains a malformed [name, value] tuple."
            };
        }
        const [name, value] = entry;
        if (typeof name !== "string" || !name.trim()) {
            return {
                ok: false,
                code: "INVALID_FORM_ENTRIES",
                error: "Form metadata contains an invalid field name."
            };
        }
        const valueType = typeof value;
        if (value !== null && value !== undefined && valueType !== "string" && valueType !== "number" && valueType !== "boolean") {
            return {
                ok: false,
                code: "INVALID_FORM_ENTRIES",
                error: "Form metadata contains a non-primitive field value."
            };
        }
        sanitized.push([name.trim(), String(value ?? "")]);
    }

    return { ok: true, entries: sanitized };
}

function isValidSaveResult(saveResult) {
    if (!saveResult || typeof saveResult !== "object" || Array.isArray(saveResult)) {
        return false;
    }
    if (typeof saveResult.filename !== "string" || !saveResult.filename.trim()) {
        return false;
    }
    if (!Number.isFinite(saveResult.size) || saveResult.size <= 0) {
        return false;
    }
    if (saveResult.path !== undefined && saveResult.path !== null && typeof saveResult.path !== "string") {
        return false;
    }
    return true;
}

/**
 * Adapter connecting Stage 2 file-system and folder-organizer utilities
 * to the Stage 3A queue save dependency without altering Stage 2 modules.
 */
export function createFileSystemSaveAdapter({
    getRootHandle,
    verifyDirectoryPermission,
    ensureSubdirectory,
    writeBinaryFile
}) {
    if (
        typeof getRootHandle !== "function" ||
        typeof verifyDirectoryPermission !== "function" ||
        typeof ensureSubdirectory !== "function" ||
        typeof writeBinaryFile !== "function"
    ) {
        throw new Error("createFileSystemSaveAdapter requires file-system service helpers.");
    }

    return async function saveMaterial({ material, downloadResult, organizationMode, folderSegments }) {
        const rootHandle = await getRootHandle();
        if (!rootHandle) {
            const err = new Error("No destination directory handle available.");
            err.code = "FS_PERMISSION_ERROR";
            throw err;
        }

        const permission = await verifyDirectoryPermission(rootHandle, { requestIfPrompt: false });
        if (permission !== "granted") {
            const err = new Error(`Destination directory permission is "${permission}".`);
            err.code = "FS_PERMISSION_ERROR";
            throw err;
        }

        const segments =
            Array.isArray(folderSegments) && folderSegments.length > 0
                ? folderSegments
                : buildTargetFolderSegments({
                      course: {
                          courseCode: material.courseCode,
                          courseName: material.courseName
                      },
                      uploadedBy: material.facultyName,
                      organizeByFaculty: organizationMode === ORGANIZATION_MODES.COURSE_FACULTY
                  });

        const targetDir = await ensureSubdirectory(rootHandle, segments);
        const desiredFilename =
            downloadResult?.cleanFilename ||
            downloadResult?.rawFilename ||
            material.rawFilename ||
            material.topic;
        const written = await writeBinaryFile(targetDir, desiredFilename, downloadResult.buffer);

        return {
            filename: written.filename,
            size: written.size,
            path: `${rootHandle.name}/${segments.join("/")}/${written.filename}`
        };
    };
}

/**
 * Sequential download queue engine (max concurrency: 1).
 *
 * Stage 3C Integration Note (Intentional Aborts):
 * When pause/cancel controls are introduced in Stage 3C, the controller should abort
 * the active `AbortController` using `createIntentionalAbortError(ABORT_REASONS.PAUSE | ABORT_REASONS.CANCEL)`
 * (and/or pass an explicit `abortReason` via the download signal). `classifyDownloadError()`
 * treats intentional aborts as non-retryable (`aborted_by_pause` / `aborted_by_cancel`) while
 * keeping genuine transport `AbortError`s retryable under `network_error`.
 */
export class DownloadQueueManager {
    #downloadMaterial;
    #saveMaterial;
    #getRetryDelayMs;
    #delayFn;
    #onEvent;
    #maxAttempts;

    #queueState = QUEUE_STATES.IDLE;
    #organizationMode = ORGANIZATION_MODES.COURSE_FACULTY;
    #formAction = "";
    #formEntries = [];
    #items = [];
    #activeDownloadCount = 0;

    constructor({
        downloadMaterial,
        saveMaterial,
        getRetryDelayMs = defaultRetryDelayMs,
        delayFn = defaultDelay,
        onEvent = null,
        maxAttempts = MAX_DOWNLOAD_ATTEMPTS
    } = {}) {
        if (typeof downloadMaterial !== "function") {
            throw new Error("DownloadQueueManager requires a downloadMaterial function.");
        }
        if (typeof saveMaterial !== "function") {
            throw new Error("DownloadQueueManager requires a saveMaterial function.");
        }
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_DOWNLOAD_ATTEMPTS) {
            throw new Error(`maxAttempts must be an integer between 1 and ${MAX_DOWNLOAD_ATTEMPTS}.`);
        }

        this.#downloadMaterial = downloadMaterial;
        this.#saveMaterial = saveMaterial;
        this.#getRetryDelayMs = getRetryDelayMs;
        this.#delayFn = delayFn;
        this.#onEvent = typeof onEvent === "function" ? onEvent : null;
        this.#maxAttempts = maxAttempts;
    }

    loadQueue(
        materials,
        {
            course = null,
            organizationMode = ORGANIZATION_MODES.COURSE_FACULTY,
            formAction = "",
            formEntries = []
        } = {}
    ) {
        if (
            this.#queueState === QUEUE_STATES.RUNNING ||
            this.#queueState === QUEUE_STATES.PAUSED ||
            this.#queueState === QUEUE_STATES.CANCELLING
        ) {
            return {
                ok: false,
                code: "QUEUE_ALREADY_RUNNING",
                error: `Cannot reload queue while queue is in "${this.#queueState}" state.`
            };
        }

        if (!VALID_ORGANIZATION_MODES.has(organizationMode)) {
            return {
                ok: false,
                code: "INVALID_ORGANIZATION_MODE",
                error: `Unsupported organization mode "${organizationMode}".`
            };
        }

        const validatedForm = validateAndCloneFormEntries(formEntries);
        if (!validatedForm.ok) {
            return validatedForm;
        }

        if (!Array.isArray(materials) || materials.length === 0) {
            this.#resetToIdle();
            return {
                ok: false,
                code: "EMPTY_QUEUE",
                error: "No materials were selected for download."
            };
        }

        const seenIds = new Set();
        const seenFileIds = new Set();
        const normalizedItems = [];
        let pendingCount = 0;

        materials.forEach((rawItem, index) => {
            const item = normalizeMaterialRecord(rawItem, index, course, organizationMode);

            if (!item.fileId) {
                item.state = transitionMaterialState(item.state, MATERIAL_STATES.SKIPPED);
                item.skipReason = "Material does not have a valid fileId.";
            } else if (seenIds.has(item.id) || seenFileIds.has(item.fileId)) {
                item.state = transitionMaterialState(item.state, MATERIAL_STATES.SKIPPED);
                item.skipReason = seenIds.has(item.id)
                    ? "Duplicate material identifier skipped."
                    : "Duplicate fileId skipped.";
            } else {
                seenIds.add(item.id);
                seenFileIds.add(item.fileId);
                pendingCount += 1;
            }

            normalizedItems.push(item);
        });

        if (pendingCount === 0) {
            this.#resetToIdle();
            return {
                ok: false,
                code: "NO_ELIGIBLE_MATERIALS",
                error: "No eligible materials with valid file IDs were found."
            };
        }

        this.#queueState = QUEUE_STATES.IDLE;
        this.#organizationMode = organizationMode;
        this.#formAction = normalizeText(formAction, "");
        // Keep auth form entries strictly private; never include in snapshots or events
        this.#formEntries = validatedForm.entries;
        this.#items = normalizedItems;

        return {
            ok: true,
            snapshot: this.getSnapshot()
        };
    }

    #resetToIdle() {
        this.#queueState = QUEUE_STATES.IDLE;
        this.#formAction = "";
        this.#formEntries = [];
        this.#items = [];
    }

    #emit(type, detail = {}) {
        if (!this.#onEvent) {
            return;
        }
        try {
            this.#onEvent({
                type,
                ...detail,
                snapshot: this.getSnapshot()
            });
        } catch {
            // Isolate listener failures so UI errors cannot corrupt queue state
        }
    }

    #setMaterialState(item, nextState) {
        const previousState = item.state;
        item.state = transitionMaterialState(previousState, nextState);
        this.#emit(QUEUE_EVENTS.MATERIAL_STATE_CHANGED, {
            materialId: item.id,
            fileId: item.fileId,
            topic: item.topic,
            previousState,
            state: item.state,
            attempts: item.attempts,
            error: item.error ? { ...item.error } : null,
            skipReason: item.skipReason
        });
    }

    async start() {
        if (this.#queueState !== QUEUE_STATES.IDLE) {
            return {
                ok: false,
                code: "INVALID_QUEUE_STATE",
                error: `Cannot start queue from "${this.#queueState}" state.`
            };
        }

        const hasPending = this.#items.some((item) => item.state === MATERIAL_STATES.PENDING);
        if (this.#items.length === 0 || !hasPending) {
            return {
                ok: false,
                code: "EMPTY_QUEUE",
                error: "Queue has no pending materials to process."
            };
        }

        this.#queueState = transitionQueueState(this.#queueState, QUEUE_STATES.RUNNING);
        this.#emit(QUEUE_EVENTS.QUEUE_STARTED);

        let unexpectedError = null;
        try {
            for (const item of this.#items) {
                if (item.state !== MATERIAL_STATES.PENDING) {
                    continue;
                }
                await this.#processItem(item);
            }
        } catch (error) {
            unexpectedError = error;
            for (const item of this.#items) {
                if (
                    item.state === MATERIAL_STATES.DOWNLOADING ||
                    item.state === MATERIAL_STATES.RETRYING
                ) {
                    item.error = classifyDownloadError(error, { phase: "download" });
                    this.#setMaterialState(item, MATERIAL_STATES.FAILED);
                } else if (item.state === MATERIAL_STATES.PENDING) {
                    item.skipReason = "Queue stopped due to unexpected internal error.";
                    this.#setMaterialState(item, MATERIAL_STATES.SKIPPED);
                }
            }
        } finally {
            const finalState = unexpectedError
                ? QUEUE_STATES.COMPLETED_WITH_ERRORS
                : computeFinalQueueState(this.#items);

            if (this.#queueState === QUEUE_STATES.RUNNING) {
                this.#queueState = transitionQueueState(this.#queueState, finalState);
            }

            const completionEvent =
                this.#queueState === QUEUE_STATES.COMPLETED
                    ? QUEUE_EVENTS.QUEUE_COMPLETED
                    : QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS;
            this.#emit(completionEvent);
        }

        if (unexpectedError) {
            const classifiedUnexpected = classifyDownloadError(unexpectedError, { phase: "download" });
            return {
                ok: false,
                code: classifiedUnexpected.code,
                error: classifiedUnexpected.message,
                snapshot: this.getSnapshot()
            };
        }

        return {
            ok: true,
            snapshot: this.getSnapshot()
        };
    }

    #handleMaterialProgress(item, rawProgress) {
        if (item.state !== MATERIAL_STATES.DOWNLOADING) {
            return;
        }
        const normalized = normalizeProgress(rawProgress);
        if (!normalized) {
            return;
        }
        item.progress = normalized;
        this.#emit(QUEUE_EVENTS.MATERIAL_PROGRESS, {
            materialId: item.id,
            fileId: item.fileId,
            topic: item.topic,
            attempt: item.attempts,
            maxAttempts: this.#maxAttempts,
            progress: { ...normalized }
        });
    }

    async #processItem(item) {
        while (item.attempts < this.#maxAttempts) {
            item.attempts += 1;
            item.progress = {
                bytesReceived: 0,
                totalBytes: null,
                percent: null,
                indeterminate: true
            };
            this.#setMaterialState(item, MATERIAL_STATES.DOWNLOADING);

            this.#emit(QUEUE_EVENTS.MATERIAL_ATTEMPT_STARTED, {
                materialId: item.id,
                fileId: item.fileId,
                topic: item.topic,
                attempt: item.attempts,
                maxAttempts: this.#maxAttempts
            });

            let phase = "download";
            try {
                if (this.#activeDownloadCount !== 0) {
                    throw new Error("Sequential concurrency invariant violated.");
                }
                this.#activeDownloadCount += 1;

                let downloadResult;
                try {
                    downloadResult = await this.#downloadMaterial({
                        formAction: this.#formAction,
                        formEntries: this.#formEntries,
                        fileId: item.fileId,
                        fallbackTitle: item.topic,
                        material: clonePublicMaterial(item),
                        onProgress: (progress) => {
                            this.#handleMaterialProgress(item, progress);
                        }
                    });
                } finally {
                    this.#activeDownloadCount -= 1;
                }

                if (!downloadResult || !downloadResult.buffer || downloadResult.buffer.byteLength === 0) {
                    const emptyErr = new Error("Download service returned an empty binary buffer.");
                    emptyErr.code = "EMPTY_RESPONSE";
                    throw emptyErr;
                }

                phase = "save";
                const folderSegments = buildTargetFolderSegments({
                    course: {
                        courseCode: item.courseCode,
                        courseName: item.courseName
                    },
                    uploadedBy: item.facultyName,
                    organizeByFaculty: item.organizationMode === ORGANIZATION_MODES.COURSE_FACULTY
                });

                const saveResult = await this.#saveMaterial({
                    material: clonePublicMaterial(item),
                    downloadResult,
                    organizationMode: item.organizationMode,
                    folderSegments
                });

                if (!isValidSaveResult(saveResult)) {
                    const invalidSaveErr = new Error(
                        "Save handler returned a missing or malformed save result."
                    );
                    invalidSaveErr.code = "FS_WRITE_ERROR";
                    throw invalidSaveErr;
                }

                item.rawFilename = downloadResult.rawFilename || item.rawFilename;
                item.savedFilename = saveResult.filename.trim();
                item.savedPath = saveResult.path ?? null;
                item.byteLength = saveResult.size;
                item.progress = {
                    bytesReceived: item.byteLength,
                    totalBytes: item.byteLength,
                    percent: 100,
                    indeterminate: false
                };
                item.error = null;

                this.#setMaterialState(item, MATERIAL_STATES.COMPLETED);
                this.#emit(QUEUE_EVENTS.MATERIAL_COMPLETED, {
                    materialId: item.id,
                    fileId: item.fileId,
                    topic: item.topic,
                    attempts: item.attempts,
                    savedFilename: item.savedFilename,
                    savedPath: item.savedPath,
                    byteLength: item.byteLength
                });
                return;
            } catch (error) {
                const classified = classifyDownloadError(error, { phase });
                item.error = classified;

                const willRetry = shouldRetryAttempt(classified, item.attempts, this.#maxAttempts);
                this.#emit(QUEUE_EVENTS.MATERIAL_ATTEMPT_FAILED, {
                    materialId: item.id,
                    fileId: item.fileId,
                    topic: item.topic,
                    attempt: item.attempts,
                    maxAttempts: this.#maxAttempts,
                    error: { ...classified },
                    willRetry
                });

                if (willRetry) {
                    this.#setMaterialState(item, MATERIAL_STATES.RETRYING);
                    const rawDelay = this.#getRetryDelayMs(item.attempts, classified);
                    const boundedDelay = Number.isFinite(rawDelay)
                        ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, rawDelay))
                        : 0;
                    await this.#delayFn(boundedDelay);
                    continue;
                }

                this.#setMaterialState(item, MATERIAL_STATES.FAILED);
                return;
            }
        }
    }

    getSnapshot() {
        const counts = {
            pending: 0,
            downloading: 0,
            retrying: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            skipped: 0
        };

        const items = this.#items.map((item) => {
            if (Object.hasOwn(counts, item.state)) {
                counts[item.state] += 1;
            }
            return clonePublicMaterial(item);
        });

        const processed = counts.completed + counts.failed + counts.cancelled + counts.skipped;
        const queuePercent = items.length > 0 ? Math.round((processed / items.length) * 100) : 0;
        const activeItem =
            items.find(
                (item) =>
                    item.state === MATERIAL_STATES.DOWNLOADING ||
                    item.state === MATERIAL_STATES.RETRYING
            ) || null;

        return {
            queueState: this.#queueState,
            organizationMode: this.#organizationMode,
            total: items.length,
            processed,
            queuePercent,
            activeItem,
            pending: counts.pending,
            downloading: counts.downloading,
            retrying: counts.retrying,
            completed: counts.completed,
            failed: counts.failed,
            cancelled: counts.cancelled,
            skipped: counts.skipped,
            items
        };
    }
}
