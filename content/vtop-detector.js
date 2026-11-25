(() => {
    if (typeof globalThis.__vtopOrganizerDetectorCleanup === "function") {
        globalThis.__vtopOrganizerDetectorCleanup();
    }

    const ALLOWED_MESSAGE_TYPES = new Set([
        "GET_VTOP_PAGE_STATE",
        "EXTRACT_COURSE_MATERIALS"
    ]);

    function onRuntimeMessage(message, sender, sendResponse) {
        if (sender.id !== chrome.runtime.id) {
            return false;
        }

        if (!message || typeof message !== "object" || !ALLOWED_MESSAGE_TYPES.has(message.type)) {
            return false;
        }

        const parser = globalThis.__vtopOrganizerCourseParser;
        if (!parser) {
            sendResponse({
                ok: false,
                code: "PARSER_UNAVAILABLE",
                error: "Course parser is not initialized."
            });
            return false;
        }

        if (message.type === "GET_VTOP_PAGE_STATE") {
            sendResponse({
                ok: true,
                detectorVersion: 2,
                isVtop: window.location.hostname === "vtop.vit.ac.in",
                pathname: window.location.pathname,
                isCourseMaterialPage: parser.isCourseMaterialPage(),
                hasDownloadForm: Boolean(document.getElementById("courseMaterialstudentfileDown"))
            });
            return false;
        }

        if (message.type === "EXTRACT_COURSE_MATERIALS") {
            parser
                .extractCourseMaterials()
                .then((result) => sendResponse(result))
                .catch((error) => {
                    sendResponse({
                        ok: false,
                        code: "EXTRACTION_FAILED",
                        error: error instanceof Error ? error.message : "Failed to extract course materials."
                    });
                });
            return true;
        }

        return false;
    }

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    globalThis.__vtopOrganizerDetectorCleanup = () => {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    };
})();
