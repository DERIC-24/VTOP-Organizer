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
