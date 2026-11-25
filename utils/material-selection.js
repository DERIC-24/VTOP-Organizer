export function buildMaterialSelectionId(item, index) {
    if (typeof item?.id === "string" && item.id.trim()) {
        return item.id.trim();
    }
    const fileId = typeof item?.fileId === "string" && item.fileId.trim() ? item.fileId.trim() : "noid";
    return `mat-${index + 1}-${fileId}`;
}

export function prepareSelectableMaterials(rawMaterials, course = null) {
    if (!Array.isArray(rawMaterials)) {
        return [];
    }
    const courseCode = typeof course?.courseCode === "string" ? course.courseCode.trim() : "";
    const courseName = typeof course?.courseName === "string" ? course.courseName.trim() : "";
    const courseType = typeof course?.courseType === "string" ? course.courseType.trim() : "";
    const courseTypeCode = typeof course?.courseTypeCode === "string" ? course.courseTypeCode.trim() : "";

    return rawMaterials.map((item, index) => ({
        ...item,
        id: buildMaterialSelectionId(item, index),
        courseCode: item?.courseCode || courseCode,
        courseName: item?.courseName || courseName,
        courseType: item?.courseType || courseType,
        courseTypeCode: item?.courseTypeCode || courseTypeCode
    }));
}

export function isSelectableMaterial(item) {
    return Boolean(item && item.hasValidFileId && typeof item.fileId === "string" && item.fileId.trim());
}

export function selectAllMaterials(materials) {
    const next = new Set();
    if (!Array.isArray(materials)) {
        return next;
    }
    for (const item of materials) {
        if (isSelectableMaterial(item)) {
            next.add(item.id);
        }
    }
    return next;
}

export function deselectAllMaterials() {
    return new Set();
}

export function toggleMaterialSelection(materials, currentSelection, materialId, forceChecked = null) {
    const next = new Set(currentSelection instanceof Set ? currentSelection : []);
    if (!Array.isArray(materials)) {
        return next;
    }
    const target = materials.find((item) => item.id === materialId);
    if (!isSelectableMaterial(target)) {
        next.delete(materialId);
        return next;
    }
    const shouldSelect = typeof forceChecked === "boolean" ? forceChecked : !next.has(materialId);
    if (shouldSelect) {
        next.add(materialId);
    } else {
        next.delete(materialId);
    }
    return next;
}

export function countSelectedMaterials(materials, selectedIds) {
    if (!Array.isArray(materials) || !(selectedIds instanceof Set) || selectedIds.size === 0) {
        return 0;
    }
    let count = 0;
    for (const item of materials) {
        if (isSelectableMaterial(item) && selectedIds.has(item.id)) {
            count += 1;
        }
    }
    return count;
}

export function buildSelectedDownloadPayload(materials, selectedIds, course = null) {
    if (!Array.isArray(materials) || !(selectedIds instanceof Set) || selectedIds.size === 0) {
        return [];
    }
    const prepared = prepareSelectableMaterials(materials, course);
    const seenIds = new Set();
    const seenFileIds = new Set();
    const result = [];

    for (const item of prepared) {
        if (!isSelectableMaterial(item) || !selectedIds.has(item.id)) {
            continue;
        }
        const fileId = item.fileId.trim();
        if (seenIds.has(item.id) || seenFileIds.has(fileId)) {
            continue;
        }
        seenIds.add(item.id);
        seenFileIds.add(fileId);
        result.push(item);
    }

    return result;
}

export function buildAllDownloadPayload(materials, course = null) {
    return prepareSelectableMaterials(materials, course);
}
