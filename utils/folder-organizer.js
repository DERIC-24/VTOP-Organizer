const WINDOWS_FORBIDDEN_CHARS = /[\\/:*?"<>|\x00-\x1f\x7f]/g;
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function sanitizePathSegment(value, fallback = "Untitled") {
    if (typeof value !== "string") {
        return fallback;
    }

    let cleaned = value
        .replace(WINDOWS_FORBIDDEN_CHARS, "_")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/g, "");

    if (!cleaned || cleaned === "." || cleaned === "..") {
        return fallback;
    }

    const dotIndex = cleaned.indexOf(".");
    const stem = dotIndex >= 0 ? cleaned.slice(0, dotIndex) : cleaned;
    if (WINDOWS_RESERVED_NAMES.test(stem)) {
        cleaned = `${cleaned}_`;
    }

    return cleaned.slice(0, 180);
}

export function buildCourseFolderName(course) {
    const code = sanitizePathSegment(course?.courseCode || "", "");
    const name = sanitizePathSegment(course?.courseName || "", "");

    if (code && name && !name.toUpperCase().startsWith(code.toUpperCase())) {
        return sanitizePathSegment(`${code} - ${name}`, "Unknown Course");
    }
    if (name) {
        return name;
    }
    if (code) {
        return code;
    }
    return "Unknown Course";
}

const COURSE_TYPE_LABELS = Object.freeze({
    ETH: "Embedded Theory",
    ELA: "Embedded Lab",
    EPJ: "Embedded Project",
    TH: "Theory Only",
    LO: "Lab Only",
    SS: "Soft Skill"
});

export function formatCourseTypeFolderSegment(course) {
    const rawType = typeof course?.courseType === "string" ? course.courseType.trim() : "";
    if (rawType) {
        const upper = rawType.toUpperCase();
        if (COURSE_TYPE_LABELS[upper]) {
            return sanitizePathSegment(`${upper} - ${COURSE_TYPE_LABELS[upper]}`, "");
        }
        return sanitizePathSegment(rawType, "");
    }

    const rawCode = typeof course?.courseTypeCode === "string" ? course.courseTypeCode.trim().toUpperCase() : "";
    if (rawCode && COURSE_TYPE_LABELS[rawCode]) {
        return sanitizePathSegment(`${rawCode} - ${COURSE_TYPE_LABELS[rawCode]}`, "");
    }

    return "";
}

export function buildTargetFolderSegments({ course, uploadedBy, organizeByFaculty = false }) {
    const segments = [buildCourseFolderName(course)];
    const courseTypeSegment = formatCourseTypeFolderSegment(course);
    if (courseTypeSegment) {
        segments.push(courseTypeSegment);
    }
    if (organizeByFaculty) {
        const faculty = sanitizePathSegment(uploadedBy || "", "Unknown Faculty");
        segments.push(faculty);
    }
    return segments;
}

export function resolveUniqueFilename(desiredName, existingLowerCaseNames) {
    const sanitized = sanitizePathSegment(desiredName, "material");
    if (!existingLowerCaseNames || !existingLowerCaseNames.has(sanitized.toLowerCase())) {
        return sanitized;
    }

    const dotIndex = sanitized.lastIndexOf(".");
    const hasExtension = dotIndex > 0 && dotIndex < sanitized.length - 1;
    const stem = hasExtension ? sanitized.slice(0, dotIndex) : sanitized;
    const ext = hasExtension ? sanitized.slice(dotIndex) : "";

    let counter = 1;
    while (counter < 10000) {
        const candidate = `${stem} (${counter})${ext}`;
        if (!existingLowerCaseNames.has(candidate.toLowerCase())) {
            return candidate;
        }
        counter += 1;
    }

    return `${stem} (${Date.now()})${ext}`;
}
