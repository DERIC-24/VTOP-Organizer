import { sanitizePathSegment } from "./folder-organizer.js";

const VTOP_FILENAME_PREFIX =
    /^[A-Z0-9-]+_[A-Z]{1,6}_[A-Z0-9]+_\d+_[A-Z0-9]+_\d{4}-\d{2}-\d{2}_(.+)$/i;

function extractBasename(rawPath) {
    if (typeof rawPath !== "string") {
        return "";
    }
    const normalized = rawPath.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    return (lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized).trim();
}

export function parseContentDisposition(headerValue) {
    if (typeof headerValue !== "string" || !headerValue.trim()) {
        return null;
    }

    // Prefer RFC 5987 filename* when present
    const extMatch = headerValue.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\r\n]+)/i);
    if (extMatch && extMatch[1]) {
        const rawEncoded = extMatch[1].trim().replace(/^["']|["']$/g, "");
        try {
            const decoded = extractBasename(decodeURIComponent(rawEncoded));
            if (decoded) {
                return decoded;
            }
        } catch {
            // Fall through to standard filename parameter
        }
    }

    const quotedMatch = headerValue.match(/filename\s*=\s*"([^"\r\n]+)"/i);
    if (quotedMatch && quotedMatch[1]) {
        const name = extractBasename(quotedMatch[1]);
        return name || null;
    }

    const unquotedMatch = headerValue.match(/filename\s*=\s*([^;\r\n]+)/i);
    if (unquotedMatch && unquotedMatch[1]) {
        const name = extractBasename(unquotedMatch[1].replace(/^['"]|['"]$/g, ""));
        return name || null;
    }

    return null;
}

export function getFileExtension(filename) {
    if (typeof filename !== "string") {
        return "";
    }
    const base = extractBasename(filename);
    const dotIndex = base.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === base.length - 1) {
        return "";
    }
    return base.slice(dotIndex).toLowerCase();
}

export function cleanVtopFilename(rawFilename, fallbackBase = "material") {
    const base = extractBasename(rawFilename);
    if (!base) {
        return sanitizePathSegment(fallbackBase, "material");
    }

    const match = base.match(VTOP_FILENAME_PREFIX);
    const stripped = match && match[1] ? match[1].trim() : base;
    return sanitizePathSegment(stripped, fallbackBase);
}
