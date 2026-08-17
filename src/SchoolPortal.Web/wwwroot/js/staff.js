(() => {
    const addForm = document.querySelector("#addStaffModal .staff-form");
    const addTitle = document.getElementById("add-staff-modal-title");
    const addSubmit = document.getElementById("add-staff-submit");
    const editTitle = document.getElementById("edit-staff-modal-title");

    const prepareAddForm = (teacherOnly, userId = "") => {
        addForm.closest("form").reset();
        addTitle.textContent = teacherOnly ? "Add Teacher Details" : "Add Staff Details";
        addSubmit.textContent = teacherOnly ? "Save Teacher" : "Save Staff";

        const designation = addForm.querySelector('[data-field="Designation"]');
        designation.value = teacherOnly ? "Teacher" : "";

        const portalUser = addForm.querySelector('[data-field="PortalUserId"]');
        portalUser.value = userId;
    };

    document.querySelectorAll(".add-staff-button").forEach(button => {
        button.addEventListener("click", () => prepareAddForm(false));
    });

    document.querySelectorAll(".add-teacher-button").forEach(button => {
        button.addEventListener("click", () => prepareAddForm(true));
    });

    document.querySelectorAll(".add-teacher-details-button").forEach(button => {
        button.addEventListener("click", () => {
            prepareAddForm(true, button.dataset.userId);
        });
    });

    document.querySelectorAll(".edit-staff-button").forEach(button => {
        button.addEventListener("click", () => {
            const staff = JSON.parse(button.dataset.staff);
            const form = document.querySelector("#editStaffModal .staff-form");
            editTitle.textContent = button.classList.contains("teacher-edit-button")
                ? "Edit Teacher Details"
                : "Edit Staff Details";
            for (const control of form.querySelectorAll("[data-field]")) {
                const value = staff[control.dataset.field];
                if (control.type === "checkbox") {
                    control.checked = Boolean(value);
                } else if (control.type === "date") {
                    control.value = value || "";
                } else {
                    control.value = value ?? "";
                }
            }
        });
    });

    const setTeacherDetail = (id, value) => {
        document.getElementById(id).textContent = value || "Not available";
    };

    document.querySelectorAll(".teacher-details-button").forEach(button => {
        button.addEventListener("click", () => {
            const teacher = JSON.parse(button.dataset.teacher);
            document.getElementById("teacher-details-name").textContent = teacher.Name;
            document.getElementById("teacher-details-ct").hidden =
                !teacher.IsClassTeacher;
            setTeacherDetail("teacher-details-staff-number", teacher.StaffNumber);
            setTeacherDetail("teacher-details-designation", teacher.Designation);
            setTeacherDetail("teacher-details-department", teacher.Department);
            setTeacherDetail("teacher-details-employment-type", teacher.EmploymentType);
            setTeacherDetail(
                "teacher-details-joining",
                teacher.DateOfJoining
                    ? new Date(`${teacher.DateOfJoining}T00:00:00`).toLocaleDateString()
                    : null);
            setTeacherDetail("teacher-details-phone", teacher.Phone);
            setTeacherDetail("teacher-details-alternate-phone", teacher.AlternatePhone);
            setTeacherDetail("teacher-details-email", teacher.Email);
            setTeacherDetail("teacher-details-address", teacher.Address);
            setTeacherDetail(
                "teacher-details-emergency-name",
                teacher.EmergencyContactName);
            setTeacherDetail(
                "teacher-details-emergency-phone",
                teacher.EmergencyContactPhone);
            setTeacherDetail("teacher-details-subjects", teacher.Subjects);
            setTeacherDetail("teacher-details-classes", teacher.Classes);
            setTeacherDetail(
                "teacher-details-class-teacher",
                teacher.ClassTeacherOf);
        });
    });
})();