(() => {
    const modalElement = document.getElementById("manageAccessModal");
    const title = document.getElementById("manage-access-title");
    const username = document.getElementById("manage-access-username");
    const userId = document.getElementById("EditAccess_UserId");
    const role = document.getElementById("EditAccess_Role");
    const active = document.getElementById("EditAccess_IsActive");

    document.querySelectorAll(".manage-access-button").forEach(button => {
        button.addEventListener("click", () => {
            title.textContent = `Manage access for ${button.dataset.displayName}`;
            username.textContent = `@${button.dataset.username}`;
            userId.value = button.dataset.userId;
            role.value = button.dataset.role;
            active.checked = button.dataset.active === "true";
        });
    });

    if (window.portalAdministrationModal) {
        const target = document.getElementById(window.portalAdministrationModal);
        if (target) {
            bootstrap.Modal.getOrCreateInstance(target).show();
        }
    }

    modalElement?.addEventListener("hidden.bs.modal", () => {
        title.textContent = "Manage access";
        username.textContent = "";
    });
})();
