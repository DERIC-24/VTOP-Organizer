(() => {
    const REQUEST_TYPE = "VTOP_ORG_EXTRACT_DATATABLES_V2";
    const RESPONSE_TYPE = "VTOP_ORG_DATATABLES_RESULT_V2";
    const ALLOWED_ORIGIN = "https://vtop.vit.ac.in";
    const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
    const COURSE_CODE_PATTERN = /\b([A-Z]{2,5}\d{3,4}[A-Z]?)\b/;
    const EMBEDDED_COURSE_TYPES = new Set(["ETH", "ELA", "EPJ"]);
    const COURSE_TYPE_LABELS = Object.freeze({
        ETH: "Embedded Theory",
        ELA: "Embedded Lab",
        EPJ: "Embedded Project",
        TH: "Theory Only",
        LO: "Lab Only",
        SS: "Soft Skill"
    });

    function formatCourseType(typeCode, rawLabel = "") {
        const normalizedCode = sanitizeString(typeCode || "", 16).toUpperCase();
        if (!normalizedCode) {
            return "";
        }
        const canonicalLabel = COURSE_TYPE_LABELS[normalizedCode] || "";
        const cleanedLabel = sanitizeString(rawLabel || "", 80)
            .replace(/\s*[-–—]\s*\d+(?:\.\d+)?\s*$/, "")
            .trim();
        const label = canonicalLabel || (!/^\d+(?:\.\d+)?$/.test(cleanedLabel) ? cleanedLabel : "");
        return label ? `${normalizedCode} - ${label}` : normalizedCode;
    }

    function sanitizeString(value, maxLength = 300, preserveNewlines = false) {
        if (typeof value !== "string") {
            return "";
        }
        if (preserveNewlines) {
            return value
                .replace(/\r\n?/g, "\n")
                .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ")
                .split("\n")
                .map((line) => line.replace(/\s+/g, " ").trim())
                .filter(Boolean)
                .join("\n")
                .slice(0, maxLength);
        }
        return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
    }

    function isCourseMaterialPage() {
        return Boolean(document.getElementById("materialTable"));
    }

    function parseCourseTitle(rawText) {
        const lines = sanitizeString(rawText, 240, true)
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);

        for (const line of lines) {
            // Pattern: "Fall Semester 2026-27 - BAECE202 - Engineering Electromagnetics - TH - Theory Only - 4.0"
            // or "BAECE203 — Analog Electronics — ETH — Embedded Theory"
            const codeMatch = line.match(/\b([A-Z]{2,5}\d{3,4}[A-Z]?)\s*[-–—:|]\s*(.+)/);
            if (codeMatch) {
                const courseCode = codeMatch[1].trim();
                let rest = codeMatch[2].trim();
                const typeMatch = rest.match(
                    /\s*[-–—]\s*(TH|LO|ETH|ELA|EPJ|SS)\b(?:\s*[-–—]\s*(.*))?$/i
                );
                let courseTypeCode = "";
                let courseTypeLabel = "";
                let courseType = "";

                if (typeMatch) {
                    courseTypeCode = typeMatch[1].toUpperCase();
                    const formattedType = formatCourseType(courseTypeCode, typeMatch[2] || "");
                    const dashIdx = formattedType.indexOf(" - ");
                    courseTypeLabel = dashIdx >= 0 ? formattedType.slice(dashIdx + 3) : "";
                    if (EMBEDDED_COURSE_TYPES.has(courseTypeCode)) {
                        courseType = formattedType;
                    }
                    rest = rest.slice(0, typeMatch.index).trim();
                }

                return {
                    courseCode,
                    courseName: sanitizeString(rest || codeMatch[2], 140),
                    courseTypeCode,
                    courseTypeLabel,
                    courseType,
                    rawTitle: line
                };
            }
        }

        const joined = lines.join(" ");
        const fallbackCode = joined.match(COURSE_CODE_PATTERN);
        if (fallbackCode) {
            return {
                courseCode: fallbackCode[1],
                courseName: joined,
                courseTypeCode: "",
                courseTypeLabel: "",
                courseType: "",
                rawTitle: joined
            };
        }

        return null;
    }

    function hasSiblingCourseTypes(courseSelect, targetCourseCode, targetTypeCode) {
        if (!courseSelect || !targetCourseCode || !targetTypeCode) {
            return false;
        }
        const options = Array.from(courseSelect.options || []);
        const seenTypes = new Set([targetTypeCode]);
        for (const option of options) {
            const text = option?.textContent || "";
            if (!text) {
                continue;
            }
            const parsed = parseCourseTitle(text);
            if (parsed && parsed.courseCode === targetCourseCode && parsed.courseTypeCode) {
                seenTypes.add(parsed.courseTypeCode);
                if (seenTypes.size > 1) {
                    return true;
                }
            }
        }
        return false;
    }

    function extractCourseInfo(materials = []) {
        // 1. VTOP Course Page Consolidated primary selector: #courseId selected option
        const courseSelect = document.getElementById("courseId");
        if (courseSelect) {
            const selectedOption =
                courseSelect.selectedOptions?.[0] ||
                courseSelect.options?.[courseSelect.selectedIndex];
            if (selectedOption?.textContent) {
                const parsed = parseCourseTitle(selectedOption.textContent);
                if (parsed) {
                    if (
                        !parsed.courseType &&
                        parsed.courseTypeCode &&
                        hasSiblingCourseTypes(courseSelect, parsed.courseCode, parsed.courseTypeCode)
                    ) {
                        parsed.courseType = formatCourseType(parsed.courseTypeCode, parsed.courseTypeLabel);
                    }
                    return parsed;
                }
            }
        }

        // 2. Fallback: Course Detail column from extracted material rows
        for (const item of materials) {
            if (item?.courseDetail) {
                const parsed = parseCourseTitle(item.courseDetail);
                if (parsed) {
                    return parsed;
                }
            }
        }

        // 3. Fallback: headings above #materialTable
        const candidates = [
            "#courseDetail h3",
            "#courseDetail h4",
            "#courseDetail .box-title",
            ".panel-heading",
            ".card-header",
            ".box-header h3",
            "#page-wrapper h3",
            "#page-wrapper h4"
        ];

        for (const selector of candidates) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
                const parsed = parseCourseTitle(el.textContent || "");
                if (parsed) {
                    return parsed;
                }
            }
        }

        return {
            courseCode: "",
            courseName: "Unknown Course",
            courseTypeCode: "",
            courseTypeLabel: "",
            courseType: "",
            rawTitle: "Unknown Course"
        };
    }

    function extractDownloadFormMetadata() {
        const form = document.getElementById("courseMaterialstudentfileDown");
        if (!form) {
            return {
                ok: false,
                code: "MISSING_DOWNLOAD_FORM",
                error: "Download form (#courseMaterialstudentfileDown) not found."
            };
        }

        const rawAction = form.getAttribute("action") || "";
        let resolvedAction;
        try {
            resolvedAction = new URL(rawAction, window.location.href);
        } catch {
            return {
                ok: false,
                code: "INVALID_FORM_ACTION",
                error: "Download form action URL is invalid."
            };
        }

        if (resolvedAction.origin !== ALLOWED_ORIGIN) {
            return {
                ok: false,
                code: "UNTRUSTED_FORM_ACTION",
                error: "Download form action origin is not trusted."
            };
        }

        const formEntries = [];
        let hasCsrf = false;
        let hasAuthorizedId = false;

        const inputs = form.querySelectorAll("input[name]");
        for (const input of inputs) {
            const name = input.getAttribute("name");
            if (!name || name === "fileId") {
                continue;
            }
            const value = input.value ?? "";
            if (name === "_csrf" && value.trim().length > 0) {
                hasCsrf = true;
            }
            if (name === "authorizedID" && value.trim().length > 0) {
                hasAuthorizedId = true;
            }
            formEntries.push([name, value]);
        }

        if (!hasCsrf || !hasAuthorizedId) {
            return {
                ok: false,
                code: "MISSING_FORM_AUTH",
                error: "VTOP form authentication fields (_csrf / authorizedID) are missing. Please refresh or log in again."
            };
        }

        return {
            ok: true,
            formAction: resolvedAction.href,
            formEntries
        };
    }

    function buildColumnMap(headers) {
        const map = {
            index: -1,
            courseDetail: -1,
            component: -1,
            topic: -1,
            uploadedBy: -1,
            uploadedDate: -1
        };

        headers.forEach((rawHeader, idx) => {
            const header = sanitizeString(rawHeader, 120).toLowerCase();
            if (!header) {
                return;
            }
            if (map.index === -1 && /^(#|sl\.?\s*no|s\.?\s*no)$/.test(header)) {
                map.index = idx;
            } else if (map.courseDetail === -1 && /course\s*detail/.test(header)) {
                map.courseDetail = idx;
            } else if (map.uploadedBy === -1 && /uploaded\s*by|faculty|staff/.test(header)) {
                map.uploadedBy = idx;
            } else if (map.uploadedDate === -1 && /date|uploaded\s*on/.test(header)) {
                map.uploadedDate = idx;
            } else if (map.component === -1 && /component|course\s*type|class|slot/.test(header)) {
                map.component = idx;
            } else if (map.topic === -1 && /material\s*detail|topic|material|title|lecture|description|reference/.test(header)) {
                map.topic = idx;
            }
        });

        return map;
    }

    function parseUploadedByCell(rawCell) {
        const lines = sanitizeString(rawCell, 300, true)
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);

        const facultyLine = lines[0] || "";
        let uploadedDate = lines[1] || "";

        if (!uploadedDate) {
            const dateMatch = facultyLine.match(/\b(\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})\b/);
            if (dateMatch) {
                uploadedDate = dateMatch[1];
            }
        }

        // VTOP format: "10001 - FACULTY ONE - SENSE" -> "FACULTY ONE"
        let facultyName = facultyLine;
        const vtopFacultyMatch = facultyLine.match(/^\d+\s*-\s*(.+?)(?:\s*-\s*[A-Z]{2,10})?$/);
        if (vtopFacultyMatch && vtopFacultyMatch[1]) {
            facultyName = vtopFacultyMatch[1].trim();
        }

        return {
            uploadedBy: sanitizeString(facultyName, 140),
            uploadedDate: sanitizeString(uploadedDate, 40)
        };
    }

    function parseTopicCell(rawCell, fallbackTopic) {
        const lines = sanitizeString(rawCell, 300, true)
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        return sanitizeString(lines[0] || fallbackTopic, 200);
    }

    function normalizeMaterialRow(rawRow, rowIndex, columnMap) {
        if (!rawRow || typeof rawRow !== "object" || !Array.isArray(rawRow.cells)) {
            return null;
        }

        const cells = rawRow.cells.map((cell) => sanitizeString(cell, 300, true));
        const rawFileId = sanitizeString(rawRow.fileId || "", 64);
        const hasValidFileId = FILE_ID_PATTERN.test(rawFileId);

        const pickCell = (mappedIdx, fallbackIdx) => {
            if (mappedIdx >= 0 && mappedIdx < cells.length) {
                return cells[mappedIdx];
            }
            if (fallbackIdx >= 0 && fallbackIdx < cells.length) {
                return cells[fallbackIdx];
            }
            return "";
        };

        const rowNumber = sanitizeString(pickCell(columnMap.index, 0), 20) || String(rowIndex + 1);
        const courseDetail = sanitizeString(pickCell(columnMap.courseDetail, cells.length >= 5 ? 1 : -1), 240, true);
        const rawTopicCell = pickCell(columnMap.topic, cells.length >= 5 ? 2 : 1);
        const topic = parseTopicCell(rawTopicCell, `Material ${rowIndex + 1}`);

        const rawUploadedBy = pickCell(columnMap.uploadedBy, cells.length >= 5 ? 3 : 2);
        const parsedFaculty = parseUploadedByCell(rawUploadedBy);
        const explicitDate = sanitizeString(pickCell(columnMap.uploadedDate, -1), 40);

        const componentMatch = courseDetail.match(/\b(TH|LO|ETH|ELA|EPJ|SS)\b/i);
        const component =
            sanitizeString(pickCell(columnMap.component, -1), 40) ||
            (componentMatch ? componentMatch[1].toUpperCase() : "");
        const normalizedComponent = component.toUpperCase();
        const courseType = EMBEDDED_COURSE_TYPES.has(normalizedComponent)
            ? formatCourseType(normalizedComponent)
            : "";

        return {
            rowNumber,
            courseDetail,
            component,
            courseTypeCode: normalizedComponent,
            courseType,
            topic,
            uploadedBy: parsedFaculty.uploadedBy,
            uploadedDate: explicitDate || parsedFaculty.uploadedDate,
            fileId: hasValidFileId ? rawFileId : "",
            hasValidFileId
        };
    }

    function requestDataTablesRows(timeoutMs = 6000) {
        return new Promise((resolve) => {
            const requestId = crypto.randomUUID();
            let settled = false;

            const cleanup = () => {
                window.removeEventListener("message", onMessage);
                clearTimeout(timer);
            };

            const onMessage = (event) => {
                if (event.source !== window || event.origin !== window.location.origin) {
                    return;
                }
                const data = event.data;
                if (
                    !data ||
                    typeof data !== "object" ||
                    data.type !== RESPONSE_TYPE ||
                    data.requestId !== requestId
                ) {
                    return;
                }

                settled = true;
                cleanup();

                const payload = data.payload;
                if (!payload || typeof payload !== "object" || typeof payload.ok !== "boolean") {
                    resolve({
                        ok: false,
                        code: "INVALID_BRIDGE_PAYLOAD",
                        error: "Received malformed payload from MAIN-world extraction bridge."
                    });
                    return;
                }

                resolve(payload);
            };

            const timer = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve({
                    ok: false,
                    code: "BRIDGE_TIMEOUT",
                    error: "Timed out waiting for DataTables extraction bridge. Reload the VTOP tab and try again."
                });
            }, timeoutMs);

            window.addEventListener("message", onMessage);
            window.postMessage({ type: REQUEST_TYPE, requestId }, window.location.origin);
        });
    }

    async function extractCourseMaterials() {
        if (!isCourseMaterialPage()) {
            return {
                ok: false,
                code: "NOT_COURSE_PAGE",
                error: "Open VTOP Course Page Consolidated (#materialTable) to scan materials."
            };
        }

        const bridgeResult = await requestDataTablesRows();
        if (!bridgeResult.ok) {
            return bridgeResult;
        }

        if (!Array.isArray(bridgeResult.rows)) {
            return {
                ok: false,
                code: "INVALID_BRIDGE_ROWS",
                error: "Bridge returned invalid row collection."
            };
        }

        const headers = Array.isArray(bridgeResult.headers) ? bridgeResult.headers : [];
        const columnMap = buildColumnMap(headers);
        const materials = [];
        let validFileIds = 0;

        bridgeResult.rows.forEach((rawRow, idx) => {
            const normalized = normalizeMaterialRow(rawRow, idx, columnMap);
            if (!normalized) {
                return;
            }
            if (normalized.hasValidFileId) {
                validFileIds += 1;
            }
            materials.push(normalized);
        });

        const course = extractCourseInfo(materials);
        for (const material of materials) {
            if (!material.courseType && course.courseType) {
                material.courseType = course.courseType;
            }
            if (!material.courseTypeCode && course.courseTypeCode) {
                material.courseTypeCode = course.courseTypeCode;
            }
        }
        const formMeta = extractDownloadFormMetadata();

        return {
            ok: true,
            course,
            formAvailable: formMeta.ok,
            formError: formMeta.ok ? null : formMeta.error,
            formAction: formMeta.ok ? formMeta.formAction : null,
            formEntries: formMeta.ok ? formMeta.formEntries : [],
            materials,
            stats: {
                extractionMode: bridgeResult.extractionMode || "unknown",
                domRowCount: Number.isFinite(bridgeResult.domRowCount) ? bridgeResult.domRowCount : 0,
                totalRows: materials.length,
                validFileIds,
                missingFileIds: materials.length - validFileIds
            }
        };
    }

    globalThis.__vtopOrganizerCourseParser = {
        isCourseMaterialPage,
        parseCourseTitle,
        extractCourseInfo,
        extractDownloadFormMetadata,
        buildColumnMap,
        normalizeMaterialRow,
        extractCourseMaterials
    };
})();
