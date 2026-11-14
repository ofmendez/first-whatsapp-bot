import { readFile } from "node:fs/promises";
import { expect, mock, test } from "bun:test";
import {
  ALBUM_PAGE_SIZE,
  AlbumGalleryLoader,
  albumPlacement,
  formatAlbumDate,
} from "@/src/album-gallery-loader.js";
import { createAlbumPhoto } from "@/src/album-gallery-render.js";
import { initializeAlbumGallery } from "@/src/album-gallery-runtime.js";

const imageId = (digit) => `${digit}0000000-0000-4000-8000-${digit}00000000000`.slice(0, 36);
const date = "2026-11-12T23:45:00.000Z";
const record = (id, extra = {}) => ({
  id,
  mediaUrl: `/api/album/media/${id}`,
  date,
  ...extra,
});
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.className = "";
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name);
  }

  append(...elements) {
    for (const element of elements) {
      element.parentElement = this;
      element.ownerDocument = this.ownerDocument;
      this.children.push(element);
    }
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name) {
    for (const listener of this.listeners.get(name) ?? []) listener({ type: name });
  }

  click() {
    this.dispatch("click");
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  matches(selector) {
    const dataAttribute = /^\[data-([a-z-]+)\]$/.exec(selector);
    if (dataAttribute) {
      const key = dataAttribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return Object.hasOwn(this.dataset, key);
    }
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return false;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) {
      if (child.matches(selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.root = new FakeElement("document");
    this.root.ownerDocument = this;
    this.activeElement = null;
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  querySelector(selector) {
    return this.root.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.root.querySelectorAll(selector);
  }
}

function galleryDocument() {
  const document = new FakeDocument();
  const gallery = new FakeElement("section");
  gallery.ownerDocument = document;
  gallery.dataset.albumGallery = "";
  const grid = new FakeElement("div");
  grid.dataset.albumGrid = "";
  const status = new FakeElement("p");
  status.dataset.albumStatus = "";
  const more = new FakeElement("button");
  more.dataset.albumMore = "";
  more.hidden = true;
  const sentinel = new FakeElement("div");
  sentinel.dataset.albumSentinel = "";
  gallery.append(grid, status, more, sentinel);
  document.root.append(gallery);
  return { document, gallery, grid, status, more, sentinel };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("dates use a deterministic Spanish UTC calendar date and reject invalid values", () => {
  expect(formatAlbumDate("2026-11-12T23:45:00.000Z")).toBe("12 de noviembre de 2026");
  expect(formatAlbumDate("2026-11-12T00:30:00+02:00")).toBeUndefined();
  expect(formatAlbumDate("not-a-date")).toBeUndefined();
});

test("gallery placement variants repeat modulo four for arbitrary collection lengths", () => {
  expect(Array.from({ length: 12 }, (_, index) => albumPlacement(index))).toEqual([
    "gallery-1",
    "gallery-2",
    "gallery-3",
    "gallery-4",
    "gallery-1",
    "gallery-2",
    "gallery-3",
    "gallery-4",
    "gallery-1",
    "gallery-2",
    "gallery-3",
    "gallery-4",
  ]);
  expect(() => albumPlacement(-1)).toThrow(RangeError);
});

test("photo rendering uses neutral alternatives, semantic dates, lazy images, and text-only captions", () => {
  const document = new FakeDocument();
  const connectFallback = mock(() => {});
  const maliciousCaption = '<img src=x onerror="alert(1)">';
  const id = imageId("a");
  const figure = createAlbumPhoto(
    {
      ...record(id, { caption: maliciousCaption }),
      dateLabel: "12 de noviembre de 2026",
    },
    5,
    document,
    connectFallback,
  );

  const [mat, caption] = figure.children;
  const [image, fallback] = mat.children;
  expect(figure.className).toContain("album-photo--gallery-2");
  expect(figure.getAttribute("role")).toBe("listitem");
  expect(image.alt).toBe("Fotografía del 12 de noviembre de 2026");
  expect(image.loading).toBe("lazy");
  expect(image.decoding).toBe("async");
  expect(image.src).toBe(`/api/album/media/${id}`);
  expect(connectFallback).toHaveBeenCalledWith(image);
  expect(fallback.getAttribute("aria-label")).toBe(
    "Fotografía no disponible. Fotografía del 12 de noviembre de 2026",
  );
  expect(caption.children[0].tagName).toBe("time");
  expect(caption.children[0].dateTime).toBe(date);
  expect(caption.children[1].textContent).toBe(maliciousCaption);
  expect(caption.children[1].innerHTML).toBeUndefined();

  const dateOnly = createAlbumPhoto(
    { ...record(imageId("b")), dateLabel: "12 de noviembre de 2026" },
    0,
    document,
    connectFallback,
  );
  expect(dateOnly.children[1].children).toHaveLength(1);
  expect(dateOnly.children[1].children[0].tagName).toBe("time");
});

test("loader bounds one active request, carries cursors, and deduplicates image IDs", async () => {
  const pending = deferred();
  const requests = [];
  const added = [];
  const states = [];
  const request = mock(async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return pending.promise;
    return jsonResponse({
      items: [record(imageId("a")), record(imageId("b"))],
      nextCursor: null,
    });
  });
  const loader = new AlbumGalleryLoader({
    request,
    origin: "https://album.example.test",
    onItems: (items) => added.push(...items),
    onState: (state) => states.push(state.phase),
  });

  const first = loader.loadNextPage();
  const duplicateCallback = loader.loadNextPage();
  expect(request).toHaveBeenCalledTimes(1);
  pending.resolve(
    jsonResponse({
      items: [record(imageId("a")), record(imageId("a"))],
      nextCursor: "next-page",
    }),
  );
  await Promise.all([first, duplicateCallback]);
  expect(loader.state.phase).toBe("ready");
  expect(loader.state.count).toBe(1);
  expect(added.map(({ id }) => id)).toEqual([imageId("a")]);

  await loader.loadNextPage();
  expect(requests).toHaveLength(2);
  expect(requests[0].url).toBe("/api/album/images?limit=24");
  expect(requests[1].url).toBe("/api/album/images?limit=24&cursor=next-page");
  expect(requests.every(({ options }) => options.credentials === "same-origin")).toBe(true);
  expect(
    requests.every(
      ({ url }) =>
        new URL(url, "https://album.example.test").origin === "https://album.example.test",
    ),
  ).toBe(true);
  expect(added.map(({ id }) => id)).toEqual([imageId("a"), imageId("b")]);
  expect(loader.state.phase).toBe("end");
  expect(await loader.loadNextPage()).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
  expect(states).toEqual(["loading-initial", "ready", "loading-more", "end"]);
});

test("loader retries the same failed cursor and preserves already loaded records", async () => {
  const request = mock()
    .mockResolvedValueOnce(
      jsonResponse({ items: [record(imageId("a"))], nextCursor: "continue-here" }),
    )
    .mockResolvedValueOnce(jsonResponse({ error: "synthetic failure" }, 503))
    .mockResolvedValueOnce(jsonResponse({ items: [record(imageId("b"))], nextCursor: null }));
  const added = [];
  const loader = new AlbumGalleryLoader({
    request,
    origin: "https://album.example.test",
    onItems: (items) => added.push(...items),
  });

  await loader.loadNextPage();
  await loader.loadNextPage();
  expect(loader.state.phase).toBe("error-more");
  expect(loader.state.count).toBe(1);
  expect(added.map(({ id }) => id)).toEqual([imageId("a")]);
  await loader.loadNextPage();

  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls[1][0]).toBe("/api/album/images?limit=24&cursor=continue-here");
  expect(request.mock.calls[2][0]).toBe("/api/album/images?limit=24&cursor=continue-here");
  expect(added.map(({ id }) => id)).toEqual([imageId("a"), imageId("b")]);
  expect(loader.state.phase).toBe("end");
});

test("loader rejects unsafe records/cursors, handles empty albums, and redirects on 401", async () => {
  const unsafeId = "not-a-uuid";
  const added = [];
  const empty = new AlbumGalleryLoader({
    request: mock(async () =>
      jsonResponse({
        items: [
          record(unsafeId),
          {
            ...record(imageId("a")),
            mediaUrl: "https://elsewhere.example/private.jpg",
          },
          record(imageId("b"), { date: "not-a-date", caption: "<b>not trusted</b>" }),
        ],
        nextCursor: null,
      }),
    ),
    onItems: (items) => added.push(...items),
  });
  await empty.loadNextPage();
  expect(empty.state.phase).toBe("empty");
  expect(added).toEqual([]);

  const unauthorized = mock();
  const redirect = mock(() => {});
  const denied = new AlbumGalleryLoader({
    request: unauthorized.mockResolvedValue(jsonResponse({}, 401)),
    onUnauthorized: redirect,
  });
  await denied.loadNextPage();
  await denied.loadNextPage();
  expect(denied.state.phase).toBe("unauthorized");
  expect(unauthorized).toHaveBeenCalledTimes(1);
  expect(redirect).toHaveBeenCalledTimes(1);
});

test("runtime exposes a keyboard load-more fallback, retry state, and image failure frame", async () => {
  const { document, gallery, grid, status, more, sentinel } = galleryDocument();
  const request = mock()
    .mockResolvedValueOnce(jsonResponse({ items: [record(imageId("a"))], nextCursor: "next" }))
    .mockResolvedValueOnce(jsonResponse({}, 503))
    .mockResolvedValueOnce(
      jsonResponse({
        items: [record(imageId("b"), { caption: "Pie de foto largo y seguro." })],
        nextCursor: null,
      }),
    );
  const window = { location: { replace: mock(() => {}) } };
  const runtime = initializeAlbumGallery({ document, window, request });
  expect(runtime).toBeDefined();
  await runtime.loader.loadNextPage();

  expect(gallery.getAttribute("aria-busy")).toBe("false");
  expect(more.hidden).toBe(false);
  expect(more.textContent).toBe("Cargar más");
  expect(sentinel.hidden).toBe(true);
  expect(grid.children).toHaveLength(1);

  const [mat] = grid.children[0].children;
  const image = mat.children[0];
  const fallback = mat.children[1];
  image.naturalWidth = 1600;
  image.naturalHeight = 900;
  image.dispatch("load");
  expect(mat.dataset.orientation).toBe("landscape");
  image.dispatch("error");
  expect(image.hidden).toBe(true);
  expect(fallback.hidden).toBe(false);

  more.focus();
  more.click();
  await runtime.loader.loadNextPage();
  expect(status.textContent).toContain("No se han podido cargar más");
  expect(more.textContent).toBe("Reintentar");
  expect(more.disabled).toBe(false);
  expect(grid.children).toHaveLength(1);

  more.click();
  await runtime.loader.loadNextPage();
  expect(request).toHaveBeenCalledTimes(3);
  expect(grid.children).toHaveLength(2);
  expect(more.hidden).toBe(true);
  expect(status.textContent).toBe("Has llegado al final del álbum.");
  expect(document.activeElement).toBe(status);
  expect(grid.children[1].children[1].children[1].textContent).toBe("Pie de foto largo y seguro.");
});

test("loaded portrait and landscape images select safe orientation frames; missing dimensions keep a fallback frame", async () => {
  const { document, grid } = galleryDocument();
  const request = mock(async () =>
    jsonResponse({
      items: [record(imageId("a")), record(imageId("b")), record(imageId("c"))],
      nextCursor: null,
    }),
  );
  const runtime = initializeAlbumGallery({
    document,
    window: { location: { replace: mock(() => {}) } },
    request,
  });
  await runtime.loader.loadNextPage();

  const [landscape, portrait, missingDimensions] = grid.children.map(
    (figure) => figure.children[0],
  );
  landscape.children[0].naturalWidth = 1920;
  landscape.children[0].naturalHeight = 1080;
  landscape.children[0].dispatch("load");
  portrait.children[0].naturalWidth = 900;
  portrait.children[0].naturalHeight = 1600;
  portrait.children[0].dispatch("load");
  expect(landscape.dataset.orientation).toBe("landscape");
  expect(portrait.dataset.orientation).toBe("portrait");
  expect(missingDimensions.dataset.orientation).toBeUndefined();
  expect(missingDimensions.className).toContain("album-photo__mat");
});

test("runtime observes the sentinel without duplicating requests and disconnects at exhaustion", async () => {
  const { document, grid, more, sentinel } = galleryDocument();
  const responses = [
    jsonResponse({ items: [record(imageId("a"))], nextCursor: "second" }),
    jsonResponse({ items: [record(imageId("b"))], nextCursor: null }),
  ];
  const request = mock(async () => responses.shift());
  let observer;
  class FakeObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observe = mock((element) => {
        this.element = element;
      });
      this.unobserve = mock(() => {});
      this.disconnect = mock(() => {});
      observer = this;
    }
  }
  const runtime = initializeAlbumGallery({
    document,
    window: { IntersectionObserver: FakeObserver, location: { replace: mock(() => {}) } },
    request,
  });
  await runtime.loader.loadNextPage();
  expect(observer.options).toEqual({ rootMargin: "480px 0px" });
  expect(observer.observe).toHaveBeenCalledWith(sentinel);

  const pending = deferred();
  request.mockImplementationOnce(() => pending.promise);
  observer.callback([{ isIntersecting: true }]);
  observer.callback([{ isIntersecting: true }]);
  expect(request).toHaveBeenCalledTimes(2);
  pending.resolve(responses.shift());
  await runtime.loader.loadNextPage();

  expect(grid.children).toHaveLength(2);
  expect(more.hidden).toBe(true);
  expect(observer.disconnect).toHaveBeenCalled();
});

test("runtime shows an empty state and sends a lost album session to login", async () => {
  const emptyElements = galleryDocument();
  const emptyRuntime = initializeAlbumGallery({
    document: emptyElements.document,
    window: { location: { replace: mock(() => {}) } },
    request: mock(async () => jsonResponse({ items: [], nextCursor: null })),
  });
  await emptyRuntime.loader.loadNextPage();
  expect(emptyElements.status.textContent).toBe("Aún no hay fotografías en este álbum.");
  expect(emptyElements.more.hidden).toBe(true);

  const deniedElements = galleryDocument();
  const replace = mock(() => {});
  const deniedRuntime = initializeAlbumGallery({
    document: deniedElements.document,
    window: { location: { replace } },
    request: mock(async () => jsonResponse({}, 401)),
  });
  await deniedRuntime.loader.loadNextPage();
  expect(deniedElements.status.textContent).toContain("sesión del álbum");
  expect(replace).toHaveBeenCalledWith("/login/");
});

test("real album page has no demo composition while login keeps its licensed illustration", async () => {
  const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [page, gallery, styles, login] = await Promise.all([
    readSource("../src/pages/album/index.astro"),
    readSource("../src/components/album/AlbumGallery.astro"),
    readSource("../src/styles/album.css"),
    readSource("../src/pages/album/login.astro"),
  ]);

  expect(page).toContain("<AlbumMasthead />");
  expect(page).toContain("<AlbumGallery />");
  expect(page).toContain('id="album-inicio"');
  expect(page).toContain('href="#album-inicio"');
  expect(page).not.toContain("AlbumOpening");
  expect(page).not.toContain("AlbumClosing");
  expect(page).not.toContain("albumDemoMemories");
  expect(gallery).toContain('<h1 id="album-title">Recuerdos</h1>');
  expect(gallery).toContain("data-album-grid");
  expect(gallery).not.toContain("Una colección de momentos");
  expect(gallery).not.toContain("Escenas pequeñas, para mirar con calma.");
  expect(gallery).not.toContain("Muestra");
  expect(gallery).not.toContain("Fotografías y textos de muestra");
  expect(styles).not.toContain(".album-opening");
  expect(styles).not.toContain(".album-closing");
  expect(styles).toContain("overflow-wrap: anywhere");
  expect(login).toContain("<AlbumPhoto");
  expect(login).toContain("Ilustración de ejemplo");
});
