(() => {
    if (typeof window.__vtopOrganizerMainBridgeCleanup === "function") {
        window.__vtopOrganizerMainBridgeCleanup();
    }

    const REQUEST_TYPE = "VTOP_ORG_EXTRACT_DATATABLES_V2";
    const RESPONSE_TYPE = "VTOP_ORG_DATATABLES_RESULT_V2";
    const MAX_CELL_LENGTH = 500;
    const MAX_FILE_ID_LENGTH = 64;
    const MAX_PAGINATION_STEPS = 50;

    function sanitizeText(value, maxLength = MAX_CELL_LENGTH, preserveNewlines = false) {
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

    function reply(requestId, payload) {
        window.postMessage(
            {
                type: RESPONSE_TYPE,
                requestId,
                payload
            },
            window.location.origin
        );
    }

    function getHeaders(table) {
        const headerRows = table.querySelectorAll("thead tr");
        const lastHeaderRow = headerRows.length > 0 ? headerRows[headerRows.length - 1] : null;
        return lastHeaderRow
            ? Array.from(lastHeaderRow.querySelectorAll("th, td")).map((th) =>
                  sanitizeText(th.innerText || th.textContent || "", 120)
              )
            : [];
    }

    function serializeRowNode(tr) {
        if (!tr || tr.querySelector(".dataTables_empty")) {
            return null;
        }
        const cells = Array.from(tr.cells || []).map((cell) =>
            sanitizeText(cell.innerText || cell.textContent || "", MAX_CELL_LENGTH, true)
        );
        const fileBtn = tr.querySelector("[data-fileid]");
        const fileId = sanitizeText(fileBtn?.getAttribute("data-fileid") || "", MAX_FILE_ID_LENGTH);
        return { cells, fileId };
    }

    function parseExpectedTotalFromInfo(tableId) {
        const infoEl = document.getElementById(`${tableId}_info`);
        if (!infoEl) {
            return null;
        }
        const match = (infoEl.textContent || "").match(/\bof\s+([\d,]+)\s+entries/i);
        if (!match) {
            return null;
        }
        const parsed = Number.parseInt(match[1].replace(/,/g, ""), 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function extractViaLivePaginationControls(table) {
        const tableId = table.id || "materialTable";
        const lengthSelect = document.querySelector(`select[name="${tableId}_length"]`);
        const paginateEl = document.getElementById(`${tableId}_paginate`);
        const expectedTotal = parseExpectedTotalFromInfo(tableId);

        const originalLength = lengthSelect ? lengthSelect.value : null;
        const originalPageBtn = paginateEl?.querySelector(".paginate_button.current, .paginate_button.active");
        const originalPageText = originalPageBtn ? originalPageBtn.textContent?.trim() : null;

        // Pick largest page size available (e.g., 100) using native change event so even
        // detached/older jQuery DataTables closures receive it.
        if (lengthSelect) {
            const numericOptions = Array.from(lengthSelect.options || [])
                .map((opt) => ({ value: opt.value, num: Number.parseInt(opt.value, 10) }))
                .filter((opt) => Number.isFinite(opt.num) && opt.num > 0)
                .sort((a, b) => b.num - a.num);

            if (numericOptions.length > 0 && lengthSelect.value !== numericOptions[0].value) {
                lengthSelect.value = numericOptions[0].value;
                lengthSelect.dispatchEvent(new Event("change", { bubbles: true }));
            }
        }

        const collected = [];
        const seenKeys = new Set();

        const collectVisibleRows = () => {
            const visibleNodes = table.querySelectorAll("tbody tr");
            for (const tr of visibleNodes) {
                const row = serializeRowNode(tr);
                if (!row) {
                    continue;
                }
                const key = row.fileId || `${row.cells[0] || ""}|${row.cells[2] || ""}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    collected.push(row);
                }
            }
        };

        const getPageClickables = () => {
            if (!paginateEl) {
                return [];
            }
            const anchors = Array.from(paginateEl.querySelectorAll("a.paginate_button, .paginate_button a"));
            return anchors.length > 0 ? anchors : Array.from(paginateEl.querySelectorAll(".paginate_button"));
        };

        // Ensure we start at page 1 if not already there
        const firstPageBtn = getPageClickables().find((el) => el.textContent?.trim() === "1");
        if (firstPageBtn && !firstPageBtn.closest(".current, .active")) {
            firstPageBtn.click();
        }

        collectVisibleRows();

        for (let step = 0; step < MAX_PAGINATION_STEPS; step += 1) {
            const nextContainer = document.getElementById(`${tableId}_next`);
            if (!nextContainer || nextContainer.classList.contains("disabled")) {
                break;
            }
            const clickTarget = nextContainer.querySelector("a") || nextContainer;
            const prevFirstKey = table.querySelector("tbody tr")?.textContent?.trim() || "";
            clickTarget.click();
            const nextFirstKey = table.querySelector("tbody tr")?.textContent?.trim() || "";

            if (nextFirstKey === prevFirstKey && expectedTotal !== null && collected.length >= expectedTotal) {
                break;
            }
            const prevCount = collected.length;
            collectVisibleRows();
            if (collected.length === prevCount) {
                break;
            }
        }

        // Restore user's original page size and page number
        if (lengthSelect && originalLength !== null && lengthSelect.value !== originalLength) {
            lengthSelect.value = originalLength;
            lengthSelect.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (originalPageText && paginateEl) {
            const restoreBtn = getPageClickables().find((el) => el.textContent?.trim() === originalPageText);
            restoreBtn?.click();
        }

        if (expectedTotal !== null && collected.length < expectedTotal) {
            return {
                ok: false,
                code: "INCOMPLETE_PAGINATION_EXTRACTION",
                error: `Expected ${expectedTotal} records from DataTables info, but collected ${collected.length}.`
            };
        }

        return {
            ok: true,
            extractionMode: "pagination-sweep",
            rows: collected
        };
    }

    function extractMaterialTable() {
        const table = document.getElementById("materialTable");
        if (!table) {
            return {
                ok: false,
                code: "NO_MATERIAL_TABLE",
                error: "Material table (#materialTable) not found on this page."
            };
        }

        const domRowCount = table.querySelectorAll("tbody tr").length;
        const headers = getHeaders(table);
        const hasJQuery = typeof window.jQuery === "function";
        const hasDataTableFn = hasJQuery && Boolean(window.jQuery.fn && window.jQuery.fn.DataTable);

        // Tier 1: Direct DataTables API (zero DOM mutation)
        if (hasDataTableFn && window.jQuery.fn.DataTable.isDataTable(table)) {
            const dt = window.jQuery(table).DataTable();
            const rowNodes = dt.rows().nodes().toArray();
            const rows = [];

            for (const tr of rowNodes) {
                const row = serializeRowNode(tr);
                if (row) {
                    rows.push(row);
                }
            }

            return {
                ok: true,
                dataTablesInitialized: true,
                extractionMode: "datatables-api",
                domRowCount,
                totalRows: rows.length,
                headers,
                rows
            };
        }

        // Tier 2: DataTables wrapper/pagination present, but jQuery DataTables global registry
        // was reset by a subsequent VTOP AJAX script load. Sweep live pagination controls.
        const hasPaginationControls = Boolean(
            table.closest(".dataTables_wrapper") ||
                document.getElementById("materialTable_paginate") ||
                document.querySelector('select[name="materialTable_length"]')
        );

        if (hasPaginationControls) {
            const sweepResult = extractViaLivePaginationControls(table);
            if (!sweepResult.ok) {
                return {
                    ...sweepResult,
                    domRowCount
                };
            }
            return {
                ok: true,
                dataTablesInitialized: false,
                extractionMode: sweepResult.extractionMode,
                domRowCount,
                totalRows: sweepResult.rows.length,
                headers,
                rows: sweepResult.rows
            };
        }

        // Tier 3: Unpaginated plain HTML table
        const plainRows = [];
        for (const tr of table.querySelectorAll("tbody tr")) {
            const row = serializeRowNode(tr);
            if (row) {
                plainRows.push(row);
            }
        }

        return {
            ok: true,
            dataTablesInitialized: false,
            extractionMode: "plain-dom",
            domRowCount,
            totalRows: plainRows.length,
            headers,
            rows: plainRows
        };
    }

    function onBridgeMessage(event) {
        if (event.source !== window || event.origin !== window.location.origin) {
            return;
        }

        const data = event.data;
        if (!data || typeof data !== "object" || data.type !== REQUEST_TYPE) {
            return;
        }

        if (typeof data.requestId !== "string" || data.requestId.length === 0 || data.requestId.length > 128) {
            return;
        }

        try {
            const result = extractMaterialTable();
            reply(data.requestId, result);
        } catch (error) {
            reply(data.requestId, {
                ok: false,
                code: "DATATABLES_EXTRACTION_ERROR",
                error: error instanceof Error ? error.message : "Failed to extract rows from DataTables."
            });
        }
    }

    window.addEventListener("message", onBridgeMessage);
    window.__vtopOrganizerMainBridgeCleanup = () => {
        window.removeEventListener("message", onBridgeMessage);
    };
})();
