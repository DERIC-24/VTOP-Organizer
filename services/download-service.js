import { cleanVtopFilename, getFileExtension, parseContentDisposition } from "../utils/filename-parser.js";

const ALLOWED_VTOP_ORIGIN = "https://vtop.vit.ac.in";

export class DownloadError extends Error {
    constructor(code, message, status = null) {
        super(message);
        this.name = "DownloadError";
        this.code = code;
        this.status = status;
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

export async function downloadMaterial({ formAction, formEntries, fileId, fallbackTitle = "material" }) {
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

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "";
    const contentDisposition = response.headers.get("content-disposition") || "";

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
        byteLength: buffer.byteLength
    };
}
