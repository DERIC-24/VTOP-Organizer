export const MAX_DOWNLOAD_ATTEMPTS = 3;

export const ABORT_REASONS = Object.freeze({
    PAUSE: "pause",
    CANCEL: "cancel"
});

export const ERROR_CATEGORIES = Object.freeze({
    NETWORK_ERROR: "network_error",
    SERVER_ERROR: "server_error",
    NOT_FOUND: "not_found",
    FORBIDDEN: "forbidden",
    AUTH_EXPIRED: "auth_expired",
    INVALID_HTML: "invalid_html",
    INVALID_BINARY: "invalid_binary",
    FS_PERMISSION_ERROR: "fs_permission_error",
    FS_WRITE_ERROR: "fs_write_error",
    ABORTED_BY_PAUSE: "aborted_by_pause",
    ABORTED_BY_CANCEL: "aborted_by_cancel",
    UNKNOWN_ERROR: "unknown_error"
});

const RETRYABLE_CATEGORIES = new Set([
    ERROR_CATEGORIES.NETWORK_ERROR,
    ERROR_CATEGORIES.SERVER_ERROR
]);

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

const NETWORK_ERROR_CODES = new Set([
    "NETWORK_ERROR",
    "ERR_NETWORK",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN"
]);

const NETWORK_MESSAGE_PATTERN =
    /^(?:failed to fetch|fetch failed|network\s?error(?:\s+when\s+attempting\s+to\s+fetch\s+resource\.?)?|load failed|request timed out|connection (?:reset|refused|closed|timed out))/i;

const SENSITIVE_PATTERN =
    /("?(?:_csrf|authorizedID|JSESSIONID|SERVERID|cookie)"?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;,&}]+)/gi;

export function sanitizeErrorMessage(message, fallback = "Download failed.") {
    if (typeof message !== "string" || !message.trim()) {
        return fallback;
    }
    return message.replace(SENSITIVE_PATTERN, "$1[REDACTED]").trim();
}

export function isRetryableCategory(category) {
    return RETRYABLE_CATEGORIES.has(category);
}

/**
 * Helper for Stage 3C pause/cancel controllers.
 * Pass the returned error to `AbortController.abort(createIntentionalAbortError(ABORT_REASONS.PAUSE))`
 * so `classifyDownloadError()` distinguishes intentional user aborts from genuine network interruptions.
 */
export function createIntentionalAbortError(reason = ABORT_REASONS.CANCEL, message) {
    const normalizedReason = reason === ABORT_REASONS.PAUSE ? ABORT_REASONS.PAUSE : ABORT_REASONS.CANCEL;
    const defaultMessage =
        normalizedReason === ABORT_REASONS.PAUSE
            ? "Download paused by user."
            : "Download cancelled by user.";
    const err = new Error(message || defaultMessage);
    err.name = "AbortError";
    err.intentionalAbort = true;
    err.abortReason = normalizedReason;
    err.code = normalizedReason === ABORT_REASONS.PAUSE ? "ABORTED_BY_PAUSE" : "ABORTED_BY_CANCEL";
    return err;
}

function buildClassifiedError({ category, code, message, status = null, retryable }) {
    return Object.freeze({
        category,
        code: typeof code === "string" && code ? code : category.toUpperCase(),
        message: sanitizeErrorMessage(message),
        status: Number.isInteger(status) ? status : null,
        retryable: Boolean(retryable)
    });
}

export function classifyDownloadError(error, { phase = "download", abortReason = null } = {}) {
    if (
        error &&
        typeof error === "object" &&
        typeof error.category === "string" &&
        Object.values(ERROR_CATEGORIES).includes(error.category)
    ) {
        return buildClassifiedError({
            category: error.category,
            code: error.code,
            message: error.message,
            status: error.status,
            retryable: isRetryableCategory(error.category)
        });
    }

    const name = typeof error?.name === "string" ? error.name : "";
    const code = typeof error?.code === "string" ? error.code : "";
    const status = Number.isInteger(error?.status) ? error.status : null;
    const rawMessage = typeof error?.message === "string" ? error.message : String(error || "");

    // Intentional user pause/cancel abort must take precedence over transport AbortError retry logic
    const explicitReason = error?.abortReason || abortReason;
    if (
        code === "ABORTED_BY_PAUSE" ||
        ((error?.intentionalAbort === true || name === "AbortError") && explicitReason === ABORT_REASONS.PAUSE)
    ) {
        return buildClassifiedError({
            category: ERROR_CATEGORIES.ABORTED_BY_PAUSE,
            code: "ABORTED_BY_PAUSE",
            message: rawMessage || "Download paused by user.",
            status,
            retryable: false
        });
    }

    if (
        code === "ABORTED_BY_CANCEL" ||
        error?.intentionalAbort === true ||
        (name === "AbortError" && explicitReason === ABORT_REASONS.CANCEL)
    ) {
        return buildClassifiedError({
            category: ERROR_CATEGORIES.ABORTED_BY_CANCEL,
            code: "ABORTED_BY_CANCEL",
            message: rawMessage || "Download cancelled by user.",
            status,
            retryable: false
        });
    }

    // Filesystem phase errors
    if (
        phase === "save" ||
        code === "FS_PERMISSION_ERROR" ||
        code === "FS_WRITE_ERROR" ||
        code === "FS_PERMISSION_DENIED"
    ) {
        if (
            code === "FS_PERMISSION_ERROR" ||
            code === "FS_PERMISSION_DENIED" ||
            name === "NotAllowedError" ||
            name === "SecurityError" ||
            /permission/i.test(rawMessage)
        ) {
            return buildClassifiedError({
                category: ERROR_CATEGORIES.FS_PERMISSION_ERROR,
                code: code || "FS_PERMISSION_ERROR",
                message: rawMessage || "Filesystem write permission was denied.",
                retryable: false
            });
        }

        return buildClassifiedError({
            category: ERROR_CATEGORIES.FS_WRITE_ERROR,
            code: code || "FS_WRITE_ERROR",
            message: rawMessage || "Failed to write material file to disk.",
            retryable: false
        });
    }

    // Explicit HTTP 404: treat as individual missing resource unless reliable auth evidence exists
    if (status === 404 || code === "MATERIAL_NOT_FOUND") {
        if (error?.isAuthFailure === true) {
            return buildClassifiedError({
                category: ERROR_CATEGORIES.AUTH_EXPIRED,
                code: "AUTH_EXPIRED",
                message: rawMessage || "Authentication expired.",
                status,
                retryable: false
            });
        }
        return buildClassifiedError({
            category: ERROR_CATEGORIES.NOT_FOUND,
            code: code || "MATERIAL_NOT_FOUND",
            message: rawMessage || "Material file was not found on VTOP (HTTP 404).",
            status: 404,
            retryable: false
        });
    }

    // HTTP 403 Forbidden
    if (status === 403 || code === "FORBIDDEN") {
        return buildClassifiedError({
            category: ERROR_CATEGORIES.FORBIDDEN,
            code: code || "FORBIDDEN",
            message: rawMessage || "Access to material was forbidden (HTTP 403).",
            status: 403,
            retryable: false
        });
    }

    // Authentication / session expiration
    if (
        status === 401 ||
        code === "AUTH_EXPIRED" ||
        code === "MISSING_FORM_FIELDS" ||
        code === "MISSING_FORM_AUTH" ||
        (code === "SESSION_EXPIRED" &&
            (status === 401 ||
                error?.redirected === true ||
                /session|login|auth/i.test(rawMessage)))
    ) {
        return buildClassifiedError({
            category: ERROR_CATEGORIES.AUTH_EXPIRED,
            code: code || "AUTH_EXPIRED",
            message: rawMessage || "VTOP session expired or authentication is missing.",
            status,
            retryable: false
        });
    }

    // Invalid HTML response (without explicit session/login proof or explicitly typed INVALID_HTML)
    if (code === "INVALID_HTML" || code === "SESSION_EXPIRED") {
        return buildClassifiedError({
            category: ERROR_CATEGORIES.INVALID_HTML,
            code: code || "INVALID_HTML",
            message: rawMessage || "Server returned an unexpected HTML response instead of a file.",
            status,
            retryable: false
        });
    }

    // Invalid binary response
    if (
        code === "INVALID_PDF" ||
        code === "INVALID_ARCHIVE" ||
        code === "EMPTY_RESPONSE" ||
        code === "INVALID_BINARY" ||
        code === "INVALID_FILE_ID" ||
        code === "INVALID_URL" ||
        code === "UNTRUSTED_ORIGIN"
    ) {
        return buildClassifiedError({
            category: ERROR_CATEGORIES.INVALID_BINARY,
            code,
            message: rawMessage || "Downloaded payload failed binary validation.",
            status,
            retryable: false
        });
    }

    // Retryable server errors (5xx, 408, 425, 429)
    if (
        code === "SERVER_ERROR" ||
        (status !== null && (status >= 500 || RETRYABLE_HTTP_STATUSES.has(status)))
    ) {
        return buildClassifiedError({
            category: ERROR_CATEGORIES.SERVER_ERROR,
            code: code || "SERVER_ERROR",
            message: rawMessage || `Server returned temporary error (HTTP ${status}).`,
            status,
            retryable: true
        });
    }

    const causeCode = typeof error?.cause?.code === "string" ? error.cause.code : "";

    // Genuine network / transient transport failures (including non-intentional AbortError timeouts)
    if (
        NETWORK_ERROR_CODES.has(code) ||
        NETWORK_ERROR_CODES.has(causeCode) ||
        name === "AbortError" ||
        NETWORK_MESSAGE_PATTERN.test(rawMessage)
    ) {
        return buildClassifiedError({
            category: ERROR_CATEGORIES.NETWORK_ERROR,
            code: code || causeCode || (name === "AbortError" ? "NETWORK_ABORT" : "NETWORK_ERROR"),
            message: rawMessage || "Network error during download.",
            status,
            retryable: true
        });
    }

    return buildClassifiedError({
        category: ERROR_CATEGORIES.UNKNOWN_ERROR,
        code: code || "UNKNOWN_ERROR",
        message: rawMessage || "Unknown download error.",
        status,
        retryable: false
    });
}

export function shouldRetryAttempt(classifiedError, attemptsUsed, maxAttempts = MAX_DOWNLOAD_ATTEMPTS) {
    if (!classifiedError || !classifiedError.retryable) {
        return false;
    }
    return attemptsUsed < maxAttempts;
}
