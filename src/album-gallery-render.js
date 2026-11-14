import { albumPlacement } from "@/src/album-gallery-loader.js";

export function createAlbumPhoto(record, index, document, connectImageFallback) {
  const figure = document.createElement("figure");
  figure.className = `album-photo album-photo--${albumPlacement(index)}`;
  figure.dataset.albumPhoto = "";
  figure.setAttribute("role", "listitem");

  const mat = document.createElement("div");
  mat.className = "album-photo__mat";

  const image = document.createElement("img");
  image.className = "album-photo__image";
  image.alt = `Fotografía del ${record.dateLabel}`;
  image.loading = "lazy";
  image.decoding = "async";
  image.sizes = "(max-width: 760px) 88vw, (max-width: 1100px) 60vw, 52vw";
  image.dataset.albumImage = "";
  connectImageFallback(image);
  image.src = record.mediaUrl;

  const fallback = document.createElement("span");
  fallback.className = "album-photo__fallback";
  fallback.setAttribute("role", "img");
  fallback.setAttribute("aria-label", `Fotografía no disponible. ${image.alt}`);
  fallback.hidden = true;
  fallback.textContent = "Fotografía no disponible.";
  mat.append(image, fallback);

  const caption = document.createElement("figcaption");
  caption.className = "album-photo__caption";
  const date = document.createElement("time");
  date.className = "album-photo__date";
  date.dateTime = record.date;
  date.textContent = record.dateLabel;
  caption.append(date);

  if (record.caption) {
    const text = document.createElement("p");
    text.className = "album-photo__text";
    text.textContent = record.caption;
    caption.append(text);
  }

  figure.append(mat, caption);
  return figure;
}
