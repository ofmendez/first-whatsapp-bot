const loginForm = document.querySelector("[data-album-login]");
const loginInput = document.getElementById("album-passphrase");
const loginButton = document.querySelector("[data-album-login-submit]");
const loginFeedback = document.querySelector("[data-album-login-feedback]");

function updateFeedback(element, message) {
  if (!element) return;
  element.textContent = message;
  element.hidden = message.length === 0;
}

if (loginForm && loginInput && loginButton && loginFeedback) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!loginForm.reportValidity()) return;

    const passphrase = loginInput.value;
    loginInput.value = "";
    loginButton.disabled = true;
    loginButton.textContent = "Comprobando…";
    loginForm.setAttribute("aria-busy", "true");
    updateFeedback(loginFeedback, "Comprobando la contraseña…");

    try {
      const response = await fetch("/api/album/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });

      if (response.ok) {
        window.location.replace("/");
        return;
      }
    } catch {}

    loginForm.removeAttribute("aria-busy");
    loginButton.disabled = false;
    loginButton.textContent = "Entrar al álbum";
    updateFeedback(
      loginFeedback,
      "No se pudo abrir el álbum. Comprueba la contraseña e inténtalo de nuevo.",
    );
    loginInput.focus();
  });
}

const signoutButton = document.querySelector("[data-album-signout]");
const signoutFeedback = document.querySelector("[data-album-signout-status]");

if (signoutButton && signoutFeedback) {
  signoutButton.addEventListener("click", async () => {
    signoutButton.disabled = true;
    signoutButton.textContent = "Saliendo…";
    updateFeedback(signoutFeedback, "Cerrando la sesión del álbum…");

    try {
      const response = await fetch("/api/album/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      if (response.ok) {
        window.location.replace("/login/");
        return;
      }
    } catch {}

    signoutButton.disabled = false;
    signoutButton.textContent = "Salir";
    updateFeedback(signoutFeedback, "No se pudo cerrar la sesión. Inténtalo de nuevo.");
  });
}
