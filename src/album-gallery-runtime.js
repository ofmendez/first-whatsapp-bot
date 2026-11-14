import { AlbumGalleryLoader } from "@/src/album-gallery-loader.js";
import { createAlbumPhoto } from "@/src/album-gallery-render.js";

function connectImageFallback(image) {
  const showFallback = () => {
    const mat = image.closest(".album-photo__mat");
    const fallback = mat?.querySelector(".album-photo__fallback");
    if (!fallback) return;
    image.hidden = true;
    fallback.hidden = false;
  };
  image.addEventListener(
    "load",
    () => {
      const mat = image.closest(".album-photo__mat");
      if (!mat || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
      mat.dataset.orientation =
        image.naturalWidth >= image.naturalHeight ? "landscape" : "portrait";
    },
    { once: true },
  );
  image.addEventListener("error", showFallback, { once: true });
  if (image.complete && image.naturalWidth === 0) {
    showFallback();
  }
}

export function initializeAlbumGallery({
  document = globalThis.document,
  window = globalThis.window,
  request = (...args) => globalThis.fetch(...args),
} = {}) {
  for (const image of document.querySelectorAll("[data-album-image]")) {
    connectImageFallback(image);
  }

  const gallery = document.querySelector("[data-album-gallery]");
  const grid = gallery?.querySelector("[data-album-grid]");
  const status = gallery?.querySelector("[data-album-status]");
  const moreButton = gallery?.querySelector("[data-album-more]");
  const sentinel = gallery?.querySelector("[data-album-sentinel]");
  if (!gallery || !grid || !status || !moreButton || !sentinel) return undefined;

  let renderedCount = 0;
  let observer;

  const loader = new AlbumGalleryLoader({
    request,
    onItems(records) {
      for (const record of records) {
        grid.append(createAlbumPhoto(record, renderedCount, document, connectImageFallback));
        renderedCount += 1;
      }
    },
    onState(state) {
      const isLoading = state.phase === "loading-initial" || state.phase === "loading-more";
      gallery.setAttribute("aria-busy", String(isLoading));

      if (state.phase === "loading-initial") {
        status.textContent = "Cargando los recuerdos…";
      } else if (state.phase === "loading-more") {
        status.textContent = "Cargando más fotografías…";
      } else if (state.phase === "empty") {
        status.textContent = "Aún no hay fotografías en este álbum.";
      } else if (state.phase === "error-initial") {
        status.textContent =
          "No se han podido cargar los recuerdos. Comprueba tu conexión e inténtalo de nuevo.";
      } else if (state.phase === "error-more") {
        status.textContent =
          "No se han podido cargar más fotografías. Los recuerdos ya cargados siguen aquí.";
      } else if (state.phase === "end") {
        status.textContent = "Has llegado al final del álbum.";
      } else if (state.phase === "ready") {
        status.textContent = "Se han cargado más fotografías.";
      } else if (state.phase === "unauthorized") {
        status.textContent = "La sesión del álbum ha terminado. Volviendo al acceso…";
      }

      const canContinue =
        state.phase === "ready" ||
        state.phase === "error-initial" ||
        state.phase === "error-more" ||
        (state.phase === "loading-more" && renderedCount > 0);
      const hideFocusedControl = !canContinue && document.activeElement === moreButton;
      moreButton.hidden = !canContinue;
      moreButton.disabled = state.phase === "loading-initial" && renderedCount === 0;
      moreButton.textContent =
        state.phase === "error-initial" || state.phase === "error-more"
          ? "Reintentar"
          : state.phase === "loading-more"
            ? "Cargando…"
            : "Cargar más";
      if (hideFocusedControl) status.focus();

      if (state.phase === "ready" && observer) observer.observe(sentinel);
      if (isLoading || state.phase === "error-initial" || state.phase === "error-more") {
        observer?.unobserve(sentinel);
      }
      if (state.phase === "empty" || state.phase === "end" || state.phase === "unauthorized") {
        observer?.disconnect();
      }
      if (state.phase === "unauthorized") window.location.replace("/login/");
    },
  });

  moreButton.addEventListener("click", () => {
    void loader.loadNextPage();
  });

  const Observer = window.IntersectionObserver;
  if (typeof Observer === "function") {
    observer = new Observer(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loader.loadNextPage();
      },
      { rootMargin: "480px 0px" },
    );
  } else {
    sentinel.hidden = true;
  }

  void loader.loadNextPage();
  return { loader, observer };
}
