import { buildTargetFolderSegments, formatCourseTypeFolderSegment } from "../utils/folder-organizer.js";
import {
    ABORT_REASONS,
    classifyDownloadError,
    createIntentionalAbortError,
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
    QUEUE_PAUSED: "queue:paused",
    QUEUE_RESUMED: "queue:resumed",
    QUEUE_CANCELLING: "queue:cancelling",
    QUEUE_CANCELLED: "queue:cancelled",
    QUEUE_RETRY_STARTED: "queue:retry_started",
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

export const AUTH_EXPIRED_SESSION_WARNING =
    "VTOP authentication has expired. Refresh the VTOP page (re-login if prompted), then click Refresh & Scan Course before retrying.";

export function getAuthExpiredWarning(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) {
        return null;
    }
    const hasAuthFailure = snapshot.items.some(
        (item) =>
            item.state === MATERIAL_STATES.FAILED &&
            item.error?.category === ERROR_CATEGORIES.AUTH_EXPIRED
    );
    return hasAuthFailure ? AUTH_EXPIRED_SESSION_WARNING : null;
}

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
const EMBEDDED_COURSE_TYPES = new Set(["ETH", "ELA", "EPJ"]);
const MAX_RETRY_DELAY_MS = 30000;

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function defaultDelay(ms, signal = null) {
    if (!Number.isFinite(ms) || ms <= 0 || signal?.aborted) {
        return Promise.resolve();
    }
    const boundedMs = Math.min(MAX_RETRY_DELAY_MS, ms);
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (signal) {
                signal.removeEventListener("abort", finish);
            }
            resolve();
        };
        const timer = setTimeout(finish, boundedMs);
        if (signal) {
            signal.addEventListener("abort", finish, { once: true });
        }
    });
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

function resolveCourseType(rawItem, defaultCourse) {
    const explicitItemType = normalizeText(rawItem?.courseType, "");
    if (explicitItemType) {
        return formatCourseTypeFolderSegment({ courseType: explicitItemType });
    }

    const rawCode = normalizeText(rawItem?.courseTypeCode || rawItem?.component || rawItem?.fileType, "").toUpperCase();
    if (EMBEDDED_COURSE_TYPES.has(rawCode)) {
        return formatCourseTypeFolderSegment({ courseTypeCode: rawCode });
    }

    const explicitCourseType = normalizeText(defaultCourse?.courseType, "");
    if (explicitCourseType) {
        return formatCourseTypeFolderSegment({ courseType: explicitCourseType });
    }

    const defaultCode = normalizeText(defaultCourse?.courseTypeCode, "").toUpperCase();
    if (EMBEDDED_COURSE_TYPES.has(defaultCode)) {
        return formatCourseTypeFolderSegment({ courseTypeCode: defaultCode });
    }

    return "";
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
    const courseType = resolveCourseType(rawItem, defaultCourse);
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
        courseType,
        facultyName,
        fileType,
        rawFilename,
        organizationMode,
        state: MATERIAL_STATES.PENDING,
        attempts: 0,
        manualRetryCount: 0,
        totalAttempts: 0,
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
        courseType: item.courseType,
        facultyName: item.facultyName,
        fileType: item.fileType,
        rawFilename: item.rawFilename,
        organizationMode: item.organizationMode,
        state: item.state,
        attempts: item.attempts,
        manualRetryCount: item.manualRetryCount,
        totalAttempts: item.totalAttempts,
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
                          courseName: material.courseName,
                          courseType: material.courseType
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
    #course = null;
    #formAction = "";
    #formEntries = [];
    #items = [];
    #activeDownloadCount = 0;
    #executionCycle = 0;
    #pendingAction = null;
    #activeAbortController = null;
    #runPromise = null;
    #resumeWaiter = null;
    #pauseSettledWaiter = null;
    #cancelSettledWaiter = null;

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
            this.#queueState === QUEUE_STATES.CANCELLING ||
            this.#runPromise !== null
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

        const sanitizedCourse = course
            ? {
                  courseCode: normalizeText(course.courseCode, ""),
                  courseName: normalizeText(course.courseName, "Unknown Course"),
                  courseType: resolveCourseType({}, course)
              }
            : null;

        const seenIds = new Set();
        const seenFileIds = new Set();
        const normalizedItems = [];
        let pendingCount = 0;

        materials.forEach((rawItem, index) => {
            const item = normalizeMaterialRecord(rawItem, index, sanitizedCourse, organizationMode);

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
        this.#course = sanitizedCourse;
        this.#formAction = normalizeText(formAction, "");
        // Keep auth form entries strictly private; never include in snapshots or events
        this.#formEntries = validatedForm.entries;
        this.#items = normalizedItems;
        this.#executionCycle = 0;
        this.#pendingAction = null;
        this.#activeAbortController = null;
        this.#runPromise = null;
        this.#resumeWaiter = null;
        this.#pauseSettledWaiter = null;
        this.#cancelSettledWaiter = null;

        return {
            ok: true,
            snapshot: this.getSnapshot()
        };
    }

    #resetToIdle() {
        this.#queueState = QUEUE_STATES.IDLE;
        this.#course = null;
        this.#formAction = "";
        this.#formEntries = [];
        this.#items = [];
        this.#executionCycle = 0;
        this.#pendingAction = null;
        this.#activeAbortController = null;
        this.#runPromise = null;
        this.#resumeWaiter = null;
        this.#pauseSettledWaiter = null;
        this.#cancelSettledWaiter = null;
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
            manualRetryCount: item.manualRetryCount,
            executionCycle: this.#executionCycle,
            error: item.error ? { ...item.error } : null,
            skipReason: item.skipReason
        });
    }

    async #delayWithAbort(ms, signal) {
        if (!Number.isFinite(ms) || ms <= 0 || signal?.aborted) {
            return;
        }
        const boundedDelay = Math.min(MAX_RETRY_DELAY_MS, Math.max(0, ms));
        let onAbort = null;
        const abortPromise = signal
            ? new Promise((resolve) => {
                  onAbort = () => resolve();
                  signal.addEventListener("abort", onAbort, { once: true });
              })
            : null;
        try {
            const delayPromise = Promise.resolve(this.#delayFn(boundedDelay, signal));
            if (abortPromise) {
                await Promise.race([delayPromise, abortPromise]);
            } else {
                await delayPromise;
            }
        } finally {
            if (signal && onAbort) {
                signal.removeEventListener("abort", onAbort);
            }
        }
    }

    #enterPausedState() {
        if (this.#queueState === QUEUE_STATES.RUNNING) {
            this.#queueState = transitionQueueState(this.#queueState, QUEUE_STATES.PAUSED);
            this.#pendingAction = null;
            this.#resumeWaiter = createDeferred();
            this.#emit(QUEUE_EVENTS.QUEUE_PAUSED, {
                executionCycle: this.#executionCycle
            });
        }
        if (this.#pauseSettledWaiter) {
            const waiter = this.#pauseSettledWaiter;
            this.#pauseSettledWaiter = null;
            waiter.resolve();
        }
    }

    async #waitWhilePaused() {
        if (this.#queueState !== QUEUE_STATES.PAUSED || !this.#resumeWaiter) {
            return;
        }
        await this.#resumeWaiter.promise;
        this.#resumeWaiter = null;
    }

    #cancelPendingItems() {
        for (const item of this.#items) {
            if (item.state === MATERIAL_STATES.PENDING) {
                item.progress = null;
                item.skipReason = "Cancelled by user.";
                this.#setMaterialState(item, MATERIAL_STATES.CANCELLED);
            }
        }
    }

    #resolvePauseAndCancelWaiters() {
        if (this.#pauseSettledWaiter) {
            const waiter = this.#pauseSettledWaiter;
            this.#pauseSettledWaiter = null;
            waiter.resolve();
        }
        if (this.#cancelSettledWaiter) {
            const waiter = this.#cancelSettledWaiter;
            this.#cancelSettledWaiter = null;
            waiter.resolve();
        }
        if (this.#resumeWaiter) {
            const waiter = this.#resumeWaiter;
            this.#resumeWaiter = null;
            waiter.resolve();
        }
    }

    async start() {
        return this.#startCycle({ isManualRetry: false });
    }

    async #startCycle({ isManualRetry = false } = {}) {
        if (this.#queueState !== QUEUE_STATES.IDLE || this.#runPromise !== null) {
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

        this.#executionCycle += 1;
        this.#pendingAction = null;
        this.#queueState = transitionQueueState(this.#queueState, QUEUE_STATES.RUNNING);
        this.#emit(QUEUE_EVENTS.QUEUE_STARTED, {
            executionCycle: this.#executionCycle,
            isManualRetry
        });
        if (isManualRetry) {
            this.#emit(QUEUE_EVENTS.QUEUE_RETRY_STARTED, {
                executionCycle: this.#executionCycle
            });
        }

        const runPromise = this.#runLoop();
        this.#runPromise = runPromise;
        return await runPromise;
    }

    async #runLoop() {
        let unexpectedError = null;
        try {
            for (let index = 0; index < this.#items.length; index += 1) {
                if (this.#pendingAction === "cancel") {
                    this.#cancelPendingItems();
                    break;
                }
                if (this.#pendingAction === "pause") {
                    this.#enterPausedState();
                    await this.#waitWhilePaused();
                    if (this.#pendingAction === "cancel") {
                        this.#cancelPendingItems();
                        break;
                    }
                }

                const item = this.#items[index];
                if (item.state !== MATERIAL_STATES.PENDING) {
                    continue;
                }

                const outcome = await this.#processItem(item);
                if (outcome === "paused") {
                    this.#enterPausedState();
                    await this.#waitWhilePaused();
                    if (this.#pendingAction === "cancel") {
                        this.#cancelPendingItems();
                        break;
                    }
                    index -= 1;
                } else if (outcome === "cancelled" || this.#pendingAction === "cancel") {
                    this.#cancelPendingItems();
                    break;
                }
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

            const wasCancelling = this.#queueState === QUEUE_STATES.CANCELLING;
            if (
                this.#queueState === QUEUE_STATES.RUNNING ||
                this.#queueState === QUEUE_STATES.PAUSED ||
                this.#queueState === QUEUE_STATES.CANCELLING
            ) {
                this.#queueState = transitionQueueState(this.#queueState, finalState);
            }

            this.#pendingAction = null;
            this.#activeAbortController = null;
            this.#runPromise = null;
            this.#resolvePauseAndCancelWaiters();

            const hasCancelledItems = this.#items.some(
                (item) => item.state === MATERIAL_STATES.CANCELLED
            );
            if (wasCancelling && hasCancelledItems) {
                this.#emit(QUEUE_EVENTS.QUEUE_CANCELLED, {
                    executionCycle: this.#executionCycle
                });
            }

            const completionEvent =
                this.#queueState === QUEUE_STATES.COMPLETED
                    ? QUEUE_EVENTS.QUEUE_COMPLETED
                    : QUEUE_EVENTS.QUEUE_COMPLETED_WITH_ERRORS;
            this.#emit(completionEvent, {
                executionCycle: this.#executionCycle
            });
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

    async pause() {
        if (this.#queueState === QUEUE_STATES.PAUSED) {
            return {
                ok: false,
                code: "QUEUE_ALREADY_PAUSED",
                error: "Download queue is already paused.",
                snapshot: this.getSnapshot()
            };
        }

        if (this.#queueState !== QUEUE_STATES.RUNNING) {
            return {
                ok: false,
                code: "INVALID_QUEUE_STATE",
                error: `Cannot pause queue from "${this.#queueState}" state.`
            };
        }

        if (this.#pendingAction === "cancel") {
            return {
                ok: false,
                code: "QUEUE_CANCELLING",
                error: "Cannot pause a queue that is cancelling."
            };
        }

        if (!this.#pauseSettledWaiter) {
            this.#pauseSettledWaiter = createDeferred();
        }
        const settledPromise = this.#pauseSettledWaiter.promise;

        if (this.#pendingAction !== "pause") {
            this.#pendingAction = "pause";
            this.#activeAbortController?.abort(createIntentionalAbortError(ABORT_REASONS.PAUSE));
        }

        await settledPromise;
        return {
            ok: true,
            snapshot: this.getSnapshot()
        };
    }

    async resume() {
        if (this.#queueState !== QUEUE_STATES.PAUSED || !this.#runPromise) {
            return {
                ok: false,
                code: "INVALID_QUEUE_STATE",
                error: `Cannot resume queue from "${this.#queueState}" state.`
            };
        }

        if (this.#pendingAction === "cancel") {
            return {
                ok: false,
                code: "QUEUE_CANCELLING",
                error: "Cannot resume a cancelling queue."
            };
        }

        this.#pendingAction = null;
        this.#queueState = transitionQueueState(this.#queueState, QUEUE_STATES.RUNNING);
        this.#emit(QUEUE_EVENTS.QUEUE_RESUMED, {
            executionCycle: this.#executionCycle
        });

        const waiter = this.#resumeWaiter;
        this.#resumeWaiter = null;
        waiter?.resolve();

        return await this.#runPromise;
    }

    async cancel() {
        if (
            this.#queueState !== QUEUE_STATES.RUNNING &&
            this.#queueState !== QUEUE_STATES.PAUSED &&
            this.#queueState !== QUEUE_STATES.CANCELLING
        ) {
            return {
                ok: false,
                code: "INVALID_QUEUE_STATE",
                error: `Cannot cancel queue from "${this.#queueState}" state.`
            };
        }

        if (this.#queueState === QUEUE_STATES.CANCELLING) {
            if (this.#cancelSettledWaiter) {
                await this.#cancelSettledWaiter.promise;
            } else if (this.#runPromise) {
                await this.#runPromise;
            }
            return {
                ok: true,
                snapshot: this.getSnapshot()
            };
        }

        if (!this.#cancelSettledWaiter) {
            this.#cancelSettledWaiter = createDeferred();
        }
        const settledPromise = this.#cancelSettledWaiter.promise;

        this.#pendingAction = "cancel";
        this.#queueState = transitionQueueState(this.#queueState, QUEUE_STATES.CANCELLING);
        this.#emit(QUEUE_EVENTS.QUEUE_CANCELLING, {
            executionCycle: this.#executionCycle
        });

        if (this.#pauseSettledWaiter) {
            const pWaiter = this.#pauseSettledWaiter;
            this.#pauseSettledWaiter = null;
            pWaiter.resolve();
        }

        if (this.#resumeWaiter) {
            const rWaiter = this.#resumeWaiter;
            this.#resumeWaiter = null;
            rWaiter.resolve();
        }

        this.#activeAbortController?.abort(createIntentionalAbortError(ABORT_REASONS.CANCEL));

        await settledPromise;
        return {
            ok: true,
            snapshot: this.getSnapshot()
        };
    }

    async retryFailed({ materialIds = null, formAction, formEntries } = {}) {
        if (this.#queueState !== QUEUE_STATES.COMPLETED_WITH_ERRORS || this.#runPromise !== null) {
            return {
                ok: false,
                code: "INVALID_QUEUE_STATE",
                error: `Cannot retry failed materials from "${this.#queueState}" state.`
            };
        }

        if (formEntries !== undefined) {
            const validatedForm = validateAndCloneFormEntries(formEntries);
            if (!validatedForm.ok) {
                return validatedForm;
            }
            this.#formEntries = validatedForm.entries;
        }
        if (formAction !== undefined) {
            this.#formAction = normalizeText(formAction, this.#formAction);
        }

        let targetIdSet = null;
        if (materialIds !== null && materialIds !== undefined) {
            const idList = Array.isArray(materialIds)
                ? materialIds
                : materialIds instanceof Set
                  ? Array.from(materialIds)
                  : [];
            targetIdSet = new Set(idList.map((value) => normalizeText(String(value ?? ""), "")).filter(Boolean));
            if (targetIdSet.size === 0) {
                return {
                    ok: false,
                    code: "NO_FAILED_MATERIALS",
                    error: "No failed materials were selected to retry."
                };
            }
        }

        let requeuedCount = 0;
        const nextItems = this.#items.map((item) => {
            if (item.state !== MATERIAL_STATES.FAILED) {
                return item;
            }
            if (targetIdSet && !targetIdSet.has(item.id) && !targetIdSet.has(item.fileId)) {
                return item;
            }
            requeuedCount += 1;
            return {
                id: item.id,
                fileId: item.fileId,
                topic: item.topic,
                courseCode: item.courseCode,
                courseName: item.courseName,
                courseType: item.courseType,
                facultyName: item.facultyName,
                fileType: item.fileType,
                rawFilename: item.rawFilename,
                organizationMode: item.organizationMode,
                state: MATERIAL_STATES.PENDING,
                attempts: 0,
                manualRetryCount: item.manualRetryCount + 1,
                totalAttempts: item.totalAttempts,
                progress: null,
                error: null,
                skipReason: null,
                savedFilename: null,
                savedPath: null,
                byteLength: null
            };
        });

        if (requeuedCount === 0) {
            return {
                ok: false,
                code: "NO_FAILED_MATERIALS",
                error: "No failed materials are available to retry."
            };
        }

        // Start a new execution cycle while keeping completed, skipped, and cancelled items untouched
        this.#items = nextItems;
        this.#queueState = QUEUE_STATES.IDLE;
        return await this.#startCycle({ isManualRetry: true });
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
            executionCycle: this.#executionCycle,
            manualRetryCount: item.manualRetryCount,
            isManualRetry: item.manualRetryCount > 0,
            progress: { ...normalized }
        });
    }

    async #processItem(item) {
        while (item.attempts < this.#maxAttempts) {
            if (this.#pendingAction === "cancel") {
                item.progress = null;
                item.error = classifyDownloadError(createIntentionalAbortError(ABORT_REASONS.CANCEL), {
                    phase: "download"
                });
                this.#setMaterialState(item, MATERIAL_STATES.CANCELLED);
                return "cancelled";
            }
            if (this.#pendingAction === "pause") {
                item.attempts = 0;
                item.progress = null;
                item.error = null;
                if (item.state !== MATERIAL_STATES.PENDING) {
                    this.#setMaterialState(item, MATERIAL_STATES.PENDING);
                }
                return "paused";
            }

            item.attempts += 1;
            item.totalAttempts += 1;
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
                maxAttempts: this.#maxAttempts,
                executionCycle: this.#executionCycle,
                manualRetryCount: item.manualRetryCount,
                isManualRetry: item.manualRetryCount > 0
            });

            const attemptAbortController = new AbortController();
            this.#activeAbortController = attemptAbortController;

            if (this.#pendingAction === "pause") {
                attemptAbortController.abort(createIntentionalAbortError(ABORT_REASONS.PAUSE));
            } else if (this.#pendingAction === "cancel") {
                attemptAbortController.abort(createIntentionalAbortError(ABORT_REASONS.CANCEL));
            }

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
                        signal: attemptAbortController.signal,
                        onProgress: (progress) => {
                            this.#handleMaterialProgress(item, progress);
                        }
                    });
                } finally {
                    this.#activeDownloadCount -= 1;
                    if (this.#activeAbortController === attemptAbortController) {
                        this.#activeAbortController = null;
                    }
                }

                if (this.#pendingAction === "pause" || attemptAbortController.signal.reason?.abortReason === ABORT_REASONS.PAUSE) {
                    throw createIntentionalAbortError(ABORT_REASONS.PAUSE);
                }
                if (this.#pendingAction === "cancel" || attemptAbortController.signal.reason?.abortReason === ABORT_REASONS.CANCEL) {
                    throw createIntentionalAbortError(ABORT_REASONS.CANCEL);
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
                        courseName: item.courseName,
                        courseType: item.courseType
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
                    manualRetryCount: item.manualRetryCount,
                    totalAttempts: item.totalAttempts,
                    executionCycle: this.#executionCycle,
                    isManualRetry: item.manualRetryCount > 0,
                    savedFilename: item.savedFilename,
                    savedPath: item.savedPath,
                    byteLength: item.byteLength
                });
                return "completed";
            } catch (error) {
                const classified = classifyDownloadError(error, { phase });

                if (
                    phase === "download" &&
                    this.#pendingAction === "pause" &&
                    classified.category === ERROR_CATEGORIES.ABORTED_BY_PAUSE
                ) {
                    item.attempts = 0;
                    item.progress = null;
                    item.error = null;
                    this.#setMaterialState(item, MATERIAL_STATES.PENDING);
                    return "paused";
                }

                if (
                    phase === "download" &&
                    this.#pendingAction === "cancel" &&
                    classified.category === ERROR_CATEGORIES.ABORTED_BY_CANCEL
                ) {
                    item.progress = null;
                    item.error = classified;
                    this.#setMaterialState(item, MATERIAL_STATES.CANCELLED);
                    return "cancelled";
                }

                item.error = classified;

                const willRetry =
                    this.#pendingAction === null &&
                    shouldRetryAttempt(classified, item.attempts, this.#maxAttempts);
                this.#emit(QUEUE_EVENTS.MATERIAL_ATTEMPT_FAILED, {
                    materialId: item.id,
                    fileId: item.fileId,
                    topic: item.topic,
                    attempt: item.attempts,
                    maxAttempts: this.#maxAttempts,
                    manualRetryCount: item.manualRetryCount,
                    executionCycle: this.#executionCycle,
                    isManualRetry: item.manualRetryCount > 0,
                    error: { ...classified },
                    willRetry
                });

                if (willRetry) {
                    this.#setMaterialState(item, MATERIAL_STATES.RETRYING);
                    const rawDelay = this.#getRetryDelayMs(item.attempts, classified);
                    const retryAbortController = new AbortController();
                    this.#activeAbortController = retryAbortController;
                    try {
                        await this.#delayWithAbort(rawDelay, retryAbortController.signal);
                    } finally {
                        if (this.#activeAbortController === retryAbortController) {
                            this.#activeAbortController = null;
                        }
                    }

                    if (this.#pendingAction === "cancel") {
                        item.progress = null;
                        item.error = classifyDownloadError(
                            createIntentionalAbortError(ABORT_REASONS.CANCEL),
                            { phase: "download" }
                        );
                        this.#setMaterialState(item, MATERIAL_STATES.CANCELLED);
                        return "cancelled";
                    }
                    if (this.#pendingAction === "pause") {
                        item.attempts = 0;
                        item.progress = null;
                        item.error = null;
                        this.#setMaterialState(item, MATERIAL_STATES.PENDING);
                        return "paused";
                    }
                    continue;
                }

                this.#setMaterialState(item, MATERIAL_STATES.FAILED);
                return "failed";
            }
        }
        return "failed";
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

        let hasAuthFailure = false;
        const items = this.#items.map((item) => {
            if (Object.hasOwn(counts, item.state)) {
                counts[item.state] += 1;
            }
            if (
                item.state === MATERIAL_STATES.FAILED &&
                item.error?.category === ERROR_CATEGORIES.AUTH_EXPIRED
            ) {
                hasAuthFailure = true;
            }
            const cloned = clonePublicMaterial(item);
            if (cloned.progress) {
                Object.freeze(cloned.progress);
            }
            if (cloned.error) {
                Object.freeze(cloned.error);
            }
            return Object.freeze(cloned);
        });

        const processed = counts.completed + counts.failed + counts.cancelled + counts.skipped;
        const queuePercent = items.length > 0 ? Math.round((processed / items.length) * 100) : 0;
        const activeItem =
            items.find(
                (item) =>
                    item.state === MATERIAL_STATES.DOWNLOADING ||
                    item.state === MATERIAL_STATES.RETRYING
            ) || null;

        return Object.freeze({
            queueState: this.#queueState,
            executionCycle: this.#executionCycle,
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
            canPause: this.#queueState === QUEUE_STATES.RUNNING && this.#pendingAction === null,
            canResume: this.#queueState === QUEUE_STATES.PAUSED && this.#pendingAction === null,
            canCancel:
                (this.#queueState === QUEUE_STATES.RUNNING ||
                    this.#queueState === QUEUE_STATES.PAUSED) &&
                this.#pendingAction === null,
            canRetryFailed:
                this.#queueState === QUEUE_STATES.COMPLETED_WITH_ERRORS && counts.failed > 0,
            hasAuthFailure,
            items: Object.freeze(items)
        });
    }
}
