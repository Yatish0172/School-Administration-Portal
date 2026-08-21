(() => {
    const start = document.getElementById("NewAcademicYear_StartDate");
    const end = document.getElementById("NewAcademicYear_EndDate");
    if (start && end) {
        const syncEndMinimum = () => {
            end.min = start.value || start.min;
            if (end.value && end.value <= start.value) {
                end.value = start.value;
            }
        };
        start.addEventListener("change", syncEndMinimum);
        syncEndMinimum();
    }


    const editYearStart = document.getElementById("edit-year-start");
    const editYearEnd = document.getElementById("edit-year-end");
    const syncEditYearEndMinimum = () => {
        if (editYearStart && editYearEnd) {
            editYearEnd.min = editYearStart.value || editYearStart.min;
        }
    };
    if (editYearStart && editYearEnd) {
        editYearStart.addEventListener("change", syncEditYearEndMinimum);
    }

    document.querySelectorAll(".edit-year-button").forEach(button => {
        button.addEventListener("click", () => {
            document.getElementById("edit-year-id").value = button.dataset.id;
            document.getElementById("edit-year-name").value = button.dataset.name;
            document.getElementById("edit-year-label").textContent = button.dataset.name;
            document.getElementById("edit-year-version").value = button.dataset.version;
            document.getElementById("edit-year-start").value = button.dataset.start;
            document.getElementById("edit-year-end").value = button.dataset.end;
            syncEditYearEndMinimum();
        });
    });
    document.querySelectorAll(".section-count-button").forEach(button => {
        button.addEventListener("click", () => {
            document.getElementById("section-count-class-id").value =
                button.dataset.classId;
            document.getElementById("section-count-class-name").textContent =
                button.dataset.className;
            document.getElementById("SectionCount_DesiredCount").value =
                button.dataset.sectionCount;
            document.getElementById("SectionCount_Capacity").value =
                button.dataset.capacity;
            document.getElementById("remove-class-id").value =
                button.dataset.classId;
        });
    });

    document.querySelectorAll(".edit-section-button").forEach(button => {
        button.addEventListener("click", () => {
            document.getElementById("edit-section-id").value = button.dataset.id;
            document.getElementById("edit-section-version").value =
                button.dataset.version;
            document.getElementById("edit-section-name").value =
                button.dataset.name;
            document.getElementById("edit-section-capacity").value =
                button.dataset.capacity;
            document.getElementById("edit-section-teacher").value =
                button.dataset.teacher || "";
            document.getElementById("edit-section-active").value =
                button.dataset.active === "true" ? "true" : "false";
        });
    });
    const assignmentClassChecks = [
        ...document.querySelectorAll("[data-assignment-class]")
    ];
    const assignmentSectionOptions = [
        ...document.querySelectorAll(".assignment-section-option")
    ];
    const syncAssignmentSections = () => {
        const selectedClasses = new Set(
            assignmentClassChecks
                .filter(checkbox => checkbox.checked)
                .map(checkbox => checkbox.dataset.assignmentClass)
        );
        for (const option of assignmentSectionOptions) {
            const visible = selectedClasses.has(option.dataset.classId);
            option.hidden = !visible;
            if (!visible) {
                option.querySelector("input").checked = false;
            }
        }
    };
    assignmentClassChecks.forEach(checkbox => {
        checkbox.addEventListener("change", syncAssignmentSections);
    });
    syncAssignmentSections();

    const syncBreakScope = select => {
        const range = select.closest(".modal-body")?.querySelector(".break-range");
        if (range) {
            range.hidden = select.value !== "ClassRange";
        }
    };
    document.querySelectorAll(".break-scope").forEach(select => {
        select.addEventListener("change", () => syncBreakScope(select));
        syncBreakScope(select);
    });

    document.querySelectorAll(".edit-break-button").forEach(button => {
        button.addEventListener("click", () => {
            document.getElementById("edit-break-id").value = button.dataset.id;
            document.getElementById("edit-break-version").value =
                button.dataset.version;
            document.getElementById("edit-break-name").value = button.dataset.name;
            document.getElementById("edit-break-scope").value =
                button.dataset.scope;
            document.getElementById("edit-break-from").value =
                button.dataset.from || "";
            document.getElementById("edit-break-to").value =
                button.dataset.to || "";
            document.getElementById("edit-break-start").value =
                button.dataset.start;
            document.getElementById("edit-break-end").value = button.dataset.end;
            document.getElementById("edit-break-active").value =
                button.dataset.active === "true" ? "true" : "false";
            syncBreakScope(document.getElementById("edit-break-scope"));
        });
    });
})();
