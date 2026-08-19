(() => {
    const mode = document.getElementById("Payment_Mode");
    const referenceGroup = document.querySelector("[data-payment-reference]");
    const providerGroup = document.querySelector("[data-payment-provider]");
    const reference = document.getElementById("Payment_Reference");
    const provider = document.getElementById("Payment_BankName");
    const amount = document.getElementById("Payment_Amount");
    const fullBalance = document.querySelector("[data-fill-balance]");

    function updatePaymentFields() {
        if (!mode || !referenceGroup || !providerGroup || !reference) return;
        const isCash = mode.value === "1";
        referenceGroup.hidden = isCash;
        providerGroup.hidden = isCash;
        reference.required = !isCash;
        if (isCash) {
            reference.value = "";
            if (provider) provider.value = "";
        }
    }

    mode?.addEventListener("change", updatePaymentFields);
    updatePaymentFields();

    fullBalance?.addEventListener("click", () => {
        if (!amount) return;
        amount.value = fullBalance.dataset.fillBalance ?? "";
        amount.focus();
    });
})();
