(() => {
    "use strict";

    const body = document.body;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scrollKey = `portal-scroll:${window.location.pathname}`;

    const markReady = () => {
        if (reducedMotion) {
            body.classList.add("is-ready");
            return;
        }
        requestAnimationFrame(() => body.classList.add("is-ready"));
    };

    const restoreScroll = () => {
        const savedScroll = sessionStorage.getItem(scrollKey);
        if (savedScroll === null) return;
        sessionStorage.removeItem(scrollKey);
        requestAnimationFrame(() => window.scrollTo({
            top: Number(savedScroll),
            behavior: "auto",
        }));
    };

    const normalizePath = value => {
        const path = new URL(value, window.location.origin).pathname;
        return path.length > 1 ? path.replace(/\/$/, "").toLowerCase() : "/";
    };

    const markRequiredFields = () => {
        document.querySelectorAll("[required], [data-val-required]").forEach(control => {
            if (!(control instanceof HTMLInputElement
                || control instanceof HTMLSelectElement
                || control instanceof HTMLTextAreaElement)) return;
            control.setAttribute("aria-required", "true");
            if (!control.id) return;
            const escapedId = window.CSS?.escape ? CSS.escape(control.id) : control.id;
            const label = document.querySelector(`label[for="${escapedId}"]`);
            if (label && !label.querySelector(".required-marker")) {
                const marker = document.createElement("span");
                marker.className = "required-marker";
                marker.textContent = " *";
                marker.setAttribute("aria-hidden", "true");
                label.append(marker);
            }
        });
    };

    const highlightNavigation = () => {
        const current = normalizePath(window.location.href);
        const currentSection = current.split("/")[1];
        const sectionAliases = {
            staff: "administration",
            account: "account",
        };

        document.querySelectorAll(".portal-navbar .nav-link[href]").forEach(link => {
            const target = normalizePath(link.href);
            const targetSection = target.split("/")[1];
            const isDashboard = target === "/" || target === "/index";
            const isActive = isDashboard
                ? current === "/" || current === "/index"
                : targetSection === (sectionAliases[currentSection] || currentSection);

            link.classList.toggle("active", isActive);
            if (isActive) link.setAttribute("aria-current", "page");
            else link.removeAttribute("aria-current");
        });
    };

    const setSubmitting = form => {
        if (form.dataset.submitting === "true") return false;
        form.dataset.submitting = "true";
        form.setAttribute("aria-busy", "true");

        form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(control => {
            control.dataset.portalWasDisabled = String(control.disabled);
            control.dataset.portalOriginalLabel = control instanceof HTMLInputElement
                ? control.value
                : control.textContent;
            control.disabled = true;
            control.setAttribute("aria-disabled", "true");
            control.classList.add("is-submitting");
            if (control instanceof HTMLInputElement) control.value = "Working…";
            else control.textContent = control.dataset.loadingLabel || "Working…";
        });
        return true;
    };

    const resetSubmitting = form => {
        delete form.dataset.submitting;
        form.removeAttribute("aria-busy");
        form.querySelectorAll(".is-submitting").forEach(control => {
            control.disabled = control.dataset.portalWasDisabled === "true";
            control.removeAttribute("aria-disabled");
            control.classList.remove("is-submitting");
            if (control.dataset.portalOriginalLabel !== undefined) {
                if (control instanceof HTMLInputElement) {
                    control.value = control.dataset.portalOriginalLabel;
                } else {
                    control.textContent = control.dataset.portalOriginalLabel;
                }
            }
            delete control.dataset.portalWasDisabled;
            delete control.dataset.portalOriginalLabel;
        });
    };

    document.addEventListener("submit", event => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;

        if (form.dataset.submitting === "true") {
            event.preventDefault();
            return;
        }

        if (!form.checkValidity()) return;

        if (form.method.toLowerCase() === "post") {
            sessionStorage.setItem(scrollKey, String(window.scrollY));
        }

        queueMicrotask(() => {
            if (!event.defaultPrevented) setSubmitting(form);
        });
    });

    document.addEventListener("click", event => {
        const disabledLink = event.target.closest("a.disabled, a[aria-disabled='true']");
        if (disabledLink) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        const confirmationTarget = event.target.closest("[data-confirm]");
        if (confirmationTarget
            && !window.confirm(confirmationTarget.dataset.confirm)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    });

    document.addEventListener("invalid", event => {
        const control = event.target;
        if (!(control instanceof HTMLElement)) return;
        control.setAttribute("aria-invalid", "true");
        control.closest(".mb-3, .mb-4, .col, [class*='col-'], .form-grid > div")
            ?.classList.add("has-validation-error");
    }, true);

    document.addEventListener("input", event => {
        const control = event.target;
        if (!(control instanceof HTMLInputElement
            || control instanceof HTMLSelectElement
            || control instanceof HTMLTextAreaElement)) return;
        if (control.checkValidity()) {
            control.removeAttribute("aria-invalid");
            control.closest(".has-validation-error")?.classList.remove("has-validation-error");
        }
    });

    document.addEventListener("shown.bs.modal", event => {
        const modal = event.target;
        if (!(modal instanceof HTMLElement)) return;
        const focusTarget = modal.querySelector(
            "[autofocus], input:not([type='hidden']):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)"
        );
        focusTarget?.focus({ preventScroll: true });
    });

    document.querySelectorAll("[data-auto-dismiss]").forEach(message => {
        if (!message.textContent.trim()
            || message.classList.contains("validation-summary-valid")) {
            message.hidden = true;
            return;
        }

        const delay = Number(message.dataset.autoDismiss) || 5000;
        window.setTimeout(() => {
            message.classList.add("feedback-toast-hiding");
            window.setTimeout(() => message.remove(), reducedMotion ? 0 : 350);
        }, delay);
    });

    window.addEventListener("pageshow", () => {
        document.querySelectorAll("form[data-submitting='true']").forEach(resetSubmitting);
        body.classList.remove("is-leaving");
    });

    window.addEventListener("beforeunload", () => {
        if (!reducedMotion) body.classList.add("is-leaving");
    });

    markRequiredFields();
    highlightNavigation();
    restoreScroll();
    markReady();
})();
