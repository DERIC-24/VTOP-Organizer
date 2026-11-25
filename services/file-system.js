import { resolveUniqueFilename, sanitizePathSegment } from "../utils/folder-organizer.js";

const DB_NAME = "vtop_organizer_fs";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const DIR_HANDLE_KEY = "destination_directory";

function openHandlesDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB."));
    });
}

export async function saveDirectoryHandle(handle) {
    const db = await openHandlesDb();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            store.put(handle, DIR_HANDLE_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error("Failed to persist directory handle."));
        });
    } finally {
        db.close();
    }
}

export async function loadDirectoryHandle() {
    const db = await openHandlesDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(DIR_HANDLE_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error || new Error("Failed to read directory handle."));
        });
    } finally {
        db.close();
    }
}

export async function clearDirectoryHandle() {
    const db = await openHandlesDb();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).delete(DIR_HANDLE_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error("Failed to clear directory handle."));
        });
    } finally {
        db.close();
    }
}

export async function requestDirectoryPermission(handle) {
    if (!handle) {
        return "none";
    }
    return await handle.requestPermission({ mode: "readwrite" });
}

export async function verifyDirectoryPermission(handle, { requestIfPrompt = false } = {}) {
    if (!handle) {
        return "none";
    }
    const current = await handle.queryPermission({ mode: "readwrite" });
    if (current === "granted") {
        return "granted";
    }
    if (requestIfPrompt && current === "prompt") {
        return await handle.requestPermission({ mode: "readwrite" });
    }
    return current;
}

/**
 * Invokes showDirectoryPicker() directly. Must be called synchronously inside a
 * user gesture handler before any `await` boundary.
 */
export async function pickAndSaveDirectory() {
    if (typeof window.showDirectoryPicker !== "function") {
        throw new Error("File System Access API (showDirectoryPicker) is not supported in this browser context.");
    }

    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const permission = await verifyDirectoryPermission(handle, { requestIfPrompt: false });
    await saveDirectoryHandle(handle);

    return { handle, permission };
}

export async function ensureSubdirectory(rootHandle, segments) {
    let current = rootHandle;
    for (const rawSegment of segments) {
        const segment = sanitizePathSegment(rawSegment, "Folder");
        current = await current.getDirectoryHandle(segment, { create: true });
    }
    return current;
}

export async function listExistingFilenames(dirHandle) {
    const names = new Set();
    for await (const key of dirHandle.keys()) {
        names.add(String(key).toLowerCase());
    }
    return names;
}

export async function writeBinaryFile(dirHandle, desiredFilename, data) {
    const existingNames = await listExistingFilenames(dirHandle);
    const uniqueFilename = resolveUniqueFilename(desiredFilename, existingNames);
    const fileHandle = await dirHandle.getFileHandle(uniqueFilename, { create: true });

    const writable = await fileHandle.createWritable();
    try {
        await writable.write(data);
        await writable.close();
    } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
    }

    const writtenFile = await fileHandle.getFile();
    return {
        filename: uniqueFilename,
        size: writtenFile.size
    };
}

export function buildValidSamplePdfBytes() {
    const encoder = new TextEncoder();
    const streamContent = [
        "BT",
        "/F1 16 Tf",
        "72 720 Td",
        "(VTOP Organizer - File System Access API Verified) Tj",
        "0 -24 Td",
        "/F1 11 Tf",
        "(Stage 2 test PDF generated successfully.) Tj",
        "ET"
    ].join("\n");
    const streamLength = encoder.encode(streamContent).byteLength;

    const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
        `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
        "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
    ];

    const parts = ["%PDF-1.4\n"];
    let byteOffset = encoder.encode(parts[0]).byteLength;
    const offsets = [0];

    for (const obj of objects) {
        offsets.push(byteOffset);
        parts.push(obj);
        byteOffset += encoder.encode(obj).byteLength;
    }

    const xrefOffset = byteOffset;
    const xrefLines = [
        "xref\n",
        `0 ${offsets.length}\n`,
        "0000000000 65535 f \n"
    ];

    for (let i = 1; i < offsets.length; i += 1) {
        xrefLines.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
    }

    const trailer = [
        "trailer\n",
        `<< /Size ${offsets.length} /Root 1 0 R >>\n`,
        "startxref\n",
        `${xrefOffset}\n`,
        "%%EOF\n"
    ].join("");

    parts.push(...xrefLines, trailer);
    return encoder.encode(parts.join(""));
}

export async function createStage2TestFile(rootHandle) {
    const permission = await verifyDirectoryPermission(rootHandle, { requestIfPrompt: false });
    if (permission !== "granted") {
        throw new Error(`Write permission is "${permission}". Re-authorize the destination folder first.`);
    }

    const testFolder = "VTOP-Organizer-Test";
    const targetDir = await ensureSubdirectory(rootHandle, [testFolder]);
    const samplePdf = buildValidSamplePdfBytes();
    const result = await writeBinaryFile(targetDir, "stage2-fsa-test.pdf", samplePdf);

    return {
        folderName: rootHandle.name,
        testFolder,
        fileName: result.filename,
        size: result.size
    };
}
