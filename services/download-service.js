import { cleanVtopFilename, getFileExtension, parseContentDisposition } from "../utils/filename-parser.js";

const ALLOWED_VTOP_ORIGIN = "https://vtop.vit.ac.in";
const MAX_404_INSPECT_BYTES = 2048;
const AUTH_REDIRECT_PATH_PATTERN = /\/(?:vtop\/)?(?:login|openPage|prelogin|sessionExpired|authenticate)/i;
const AUTH_HTML_MARKER_PATTERN =
    /(?:session\s*(?:expired|timed\s*out|invalid)|please\s*log\s*in|vtop\s*login|name\s*=\s*["']?j_username|action\s*=\s*["'][^"']*\/login)/i;

export class DownloadError extends Error {
    constructor(code, message, status = null, { isAuthFailure = false } = {}) {
        super(message);
        this.name = "DownloadError";
        this.code = code;
        this.status = status;
        if (isAuthFailure) {
            this.isAuthFailure = true;
        }
    }
}

export function buildFormBody(formEntries, fileId) {
    if (!Array.isArray(formEntries) || formEntries.length === 0) {
        throw new DownloadError("MISSING_FORM_FIELDS", "Form authentication entries are missing.");
    }
    if (typeof fileId !== "string" || !fileId.trim()) {
        throw new DownloadError("INVALID_FILE_ID", "Material fileId is missing or invalid.");
    }

    const params = new URLSearchParams();
    for (const entry of formEntries) {
        if (!Array.isArray(entry) || entry.length < 2) {
            continue;
        }
        const [name, value] = entry;
        if (typeof name !== "string" || name === "fileId") {
            continue;
        }
        params.append(name, String(value ?? ""));
    }
    params.append("fileId", fileId.trim());
    return params;
}

function startsWithAsciiPrefix(bytes, prefix) {
    if (bytes.length < prefix.length) {
        return false;
    }
    for (let i = 0; i < prefix.length; i += 1) {
        if (bytes[i] !== prefix.charCodeAt(i)) {
            return false;
        }
    }
    return true;
}

function looksLikeHtmlDocument(buffer) {
    const sampleLength = Math.min(buffer.byteLength, 256);
    if (sampleLength === 0) {
        return false;
    }
    const text = new TextDecoder("utf-8", { fatal: false })
        .decode(new Uint8Array(buffer, 0, sampleLength))
        .trimStart()
        .toLowerCase();

    return (
        text.startsWith("<!doctype") ||
        text.startsWith("<html") ||
        text.startsWith("<head") ||
        text.startsWith("<body") ||
        text.startsWith("<script")
    );
}

export function validateDownloadedBinary({ status, ok, redirected, contentType, contentDisposition, buffer }) {
    if (!ok) {
        if (status === 401 || status === 403) {
            throw new DownloadError("SESSION_EXPIRED", `Authentication failed (HTTP ${status}). Refresh VTOP and try again.`, status);
        }
        if (status === 404) {
            throw new DownloadError("MATERIAL_NOT_FOUND", "Material file returned HTTP 404 on VTOP.", status);
        }
        throw new DownloadError("HTTP_ERROR", `Download request failed with HTTP ${status}.`, status);
    }

    const normalizedType = (contentType || "").toLowerCase();
    if (redirected && normalizedType.includes("text/html")) {
        throw new DownloadError("SESSION_EXPIRED", "VTOP redirected to an HTML page (session likely expired).", status);
    }

    if (!buffer || buffer.byteLength === 0) {
        throw new DownloadError("EMPTY_RESPONSE", "Server returned an empty file.", status);
    }

    if (normalizedType.includes("text/html") || looksLikeHtmlDocument(buffer)) {
        throw new DownloadError("SESSION_EXPIRED", "VTOP returned HTML instead of a material file (session may have expired).", status);
    }

    const parsedFilename = parseContentDisposition(contentDisposition);
    const ext = getFileExtension(parsedFilename || "");
    const headerBytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8));

    if (ext === ".pdf" || normalizedType.includes("application/pdf")) {
        if (!startsWithAsciiPrefix(headerBytes, "%PDF")) {
            throw new DownloadError("INVALID_PDF", "Response was labeled as PDF but lacks %PDF magic bytes.", status);
        }
    } else if (ext === ".pptx" || ext === ".docx" || ext === ".xlsx" || ext === ".zip") {
        if (!startsWithAsciiPrefix(headerBytes, "PK")) {
            throw new DownloadError("INVALID_ARCHIVE", `Response for ${ext} lacks ZIP/OOXML magic bytes.`, status);
        }
    }

    return {
        rawFilename: parsedFilename,
        extension: ext
    };
}

export function parseContentLength(headerValue) {
    if (typeof headerValue !== "string" || !headerValue.trim()) {
        return null;
    }
    const trimmed = headerValue.trim();
    if (!/^\d+$/.test(trimmed)) {
        return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

export function buildProgressState(bytesReceived, totalBytes) {
    const safeBytes = Number.isFinite(bytesReceived) && bytesReceived >= 0 ? bytesReceived : 0;
    const knownTotal = Number.isSafeInteger(totalBytes) && totalBytes > 0 ? totalBytes : null;
    const indeterminate = knownTotal === null;
    const percent =
        knownTotal !== null
            ? Math.min(100, Math.round((safeBytes / knownTotal) * 100))
            : null;

    return {
        bytesReceived: safeBytes,
        totalBytes: knownTotal,
        percent,
        indeterminate
    };
}

function safeNotifyProgress(onProgress, progress) {
    if (typeof onProgress !== "function") {
        return;
    }
    try {
        onProgress(progress);
    } catch {
        // Progress listener errors must never interrupt a valid download
    }
}

async function readResponseBufferWithProgress(response, totalBytes, onProgress) {
    if (!response.body || typeof response.body.getReader !== "function") {
        const buffer = await response.arrayBuffer();
        safeNotifyProgress(onProgress, buildProgressState(buffer.byteLength, totalBytes));
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let bytesReceived = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (!value || value.byteLength === 0) {
                continue;
            }
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            chunks.push(chunk);
            bytesReceived += chunk.byteLength;
            safeNotifyProgress(onProgress, buildProgressState(bytesReceived, totalBytes));
        }
    } finally {
        reader.releaseLock?.();
    }

    if (bytesReceived === 0) {
        safeNotifyProgress(onProgress, buildProgressState(0, totalBytes));
        return new ArrayBuffer(0);
    }

    const combined = new Uint8Array(bytesReceived);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return combined.buffer;
}

async function readBoundedPrefix(response, maxBytes = MAX_404_INSPECT_BYTES) {
    if (!response.body || typeof response.body.getReader !== "function") {
        return new Uint8Array(0);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalRead = 0;
    let reachedCap = false;

    try {
        while (totalRead < maxBytes) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (!value || value.byteLength === 0) {
                continue;
            }
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            const remaining = maxBytes - totalRead;
            if (chunk.byteLength >= remaining) {
                chunks.push(chunk.subarray(0, remaining));
                totalRead += remaining;
                reachedCap = true;
                break;
            }
            chunks.push(chunk);
            totalRead += chunk.byteLength;
        }
    } finally {
        if (reachedCap) {
            await reader.cancel().catch(() => {});
        }
        reader.releaseLock?.();
    }

    const prefix = new Uint8Array(totalRead);
    let offset = 0;
    for (const chunk of chunks) {
        prefix.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return prefix;
}

async function detectAuthFailureOn404(response, contentType) {
    if (typeof response.url === "string" && response.url) {
        try {
            const resolved = new URL(response.url);
            if (AUTH_REDIRECT_PATH_PATTERN.test(resolved.pathname)) {
                await response.body?.cancel?.().catch(() => {});
                return true;
            }
        } catch {
            // Ignore invalid response.url
        }
    }

    const normalizedType = (contentType || "").toLowerCase();
    if (!normalizedType.includes("text/html") && !normalizedType.includes("application/xhtml+xml")) {
        await response.body?.cancel?.().catch(() => {});
        return false;
    }

    const prefixBytes = await readBoundedPrefix(response, MAX_404_INSPECT_BYTES);
    if (prefixBytes.byteLength === 0) {
        return false;
    }

    const prefixText = new TextDecoder("utf-8", { fatal: false }).decode(prefixBytes);
    return AUTH_HTML_MARKER_PATTERN.test(prefixText);
}

export async function downloadMaterial({
    formAction,
    formEntries,
    fileId,
    fallbackTitle = "material",
    onProgress = null
}) {
    let targetUrl;
    try {
        targetUrl = new URL(formAction);
    } catch {
        throw new DownloadError("INVALID_URL", "Invalid VTOP download endpoint URL.");
    }

    if (targetUrl.origin !== ALLOWED_VTOP_ORIGIN) {
        throw new DownloadError("UNTRUSTED_ORIGIN", "Refusing download to non-VTOP origin.");
    }

    const body = buildFormBody(formEntries, fileId);
    const response = await fetch(targetUrl.href, {
        method: "POST",
        credentials: "include",
        body
    });

    const contentType = response.headers.get("content-type") || "";
    const contentDisposition = response.headers.get("content-disposition") || "";
    const totalBytes = parseContentLength(response.headers.get("content-length"));

    // Reject non-2xx responses before streaming body or emitting progress
    if (!response.ok) {
        if (response.status === 404) {
            const isAuthFailure = await detectAuthFailureOn404(response, contentType);
            if (isAuthFailure) {
                throw new DownloadError(
                    "SESSION_EXPIRED",
                    "VTOP session expired (HTTP 404 login or session-expiry response).",
                    404,
                    { isAuthFailure: true }
                );
            }
        } else {
            await response.body?.cancel?.().catch(() => {});
        }

        validateDownloadedBinary({
            status: response.status,
            ok: response.ok,
            redirected: response.redirected,
            contentType,
            contentDisposition,
            buffer: new ArrayBuffer(0)
        });
    }

    const buffer = await readResponseBufferWithProgress(response, totalBytes, onProgress);

    const validated = validateDownloadedBinary({
        status: response.status,
        ok: response.ok,
        redirected: response.redirected,
        contentType,
        contentDisposition,
        buffer
    });

    const cleanFilename = cleanVtopFilename(
        validated.rawFilename || fallbackTitle,
        fallbackTitle
    );

    return {
        buffer,
        rawFilename: validated.rawFilename,
        cleanFilename,
        contentType,
        byteLength: buffer.byteLength,
        totalBytes
    };
}
