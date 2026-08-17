(() => {
    const scrollKey = `portal-scroll:${window.location.pathname}`;
    const savedScroll = sessionStorage.getItem(scrollKey);
    if (savedScroll !== null) {
        sessionStorage.removeItem(scrollKey);
        requestAnimationFrame(() => window.scrollTo(0, Number(savedScroll)));
    }

    document.addEventListener("submit", event => {
        const form = event.target;
        if (form instanceof HTMLFormElement
            && form.method.toLowerCase() === "post") {
            sessionStorage.setItem(scrollKey, String(window.scrollY));
        }
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
            window.setTimeout(() => message.remove(), 350);
        }, delay);
    });
})();