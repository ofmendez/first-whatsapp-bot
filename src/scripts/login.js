const form = document.getElementById("login-form");
const passphraseInput = document.getElementById("passphrase");
const submitButton = document.getElementById("login-submit");
const feedback = document.getElementById("login-feedback");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  submitButton.disabled = true;
  submitButton.textContent = "Checking…";
  feedback.hidden = true;

  const body = JSON.stringify({ passphrase: passphraseInput.value });
  passphraseInput.value = "";

  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (response.ok) {
      window.location.replace("/");
      return;
    }
  } catch {}

  feedback.textContent = "Sign-in failed. Check the passphrase and try again.";
  feedback.hidden = false;
  submitButton.disabled = false;
  submitButton.textContent = "Continue";
  passphraseInput.focus();
});
