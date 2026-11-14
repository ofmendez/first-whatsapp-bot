import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { albumLoginIllustration } from "@/src/data/album-demo.js";

test("the only bundled demo image is the licensed album login illustration", async () => {
  expect(albumLoginIllustration.id).toBe("park-walk");
  expect(albumLoginIllustration.alt.length).toBeGreaterThan(20);
  expect(albumLoginIllustration.photo.width).toBeGreaterThan(0);
  expect(albumLoginIllustration.photo.height).toBeGreaterThan(0);
  expect(albumLoginIllustration.photo.src).not.toContain("[object Object]");
  expect(albumLoginIllustration.photo.src).toContain(".webp");
  expect(albumLoginIllustration.photo.srcSet).toContain("640w");
  expect(albumLoginIllustration.photo.srcSet).toContain("1280w");
  expect(albumLoginIllustration.photo.srcSet).not.toContain("http");

  const source = await readFile(new URL("../src/data/album-demo.js", import.meta.url), "utf8");
  expect(source.match(/from "@\/src\/assets\/album\//g)).toHaveLength(2);
  expect(source).not.toContain("cafe-conversation");
  expect(source).not.toContain("home-cooking");
  expect(source).not.toContain("lakeside-walk");
  expect(source).not.toContain("mountain-view");
  expect(source).not.toContain("park-picnic");
  expect(source).not.toContain("street-cafe");
});

test("admin and album login forms use POST actions rather than URL submissions", async () => {
  const albumLogin = await Bun.file(
    new URL("../src/pages/album/login.astro", import.meta.url),
  ).text();
  const adminLogin = await Bun.file(new URL("../src/pages/login.astro", import.meta.url)).text();

  expect(albumLogin).toMatch(
    /<form[\s\S]*?method="post"[\s\S]*?action="\/api\/album\/auth\/login"/,
  );
  expect(adminLogin).toMatch(/<form[\s\S]*?method="post"[\s\S]*?action="\/api\/auth\/login"/);
});

test("album sign-out feedback remains visible and announced on failure", async () => {
  const masthead = await Bun.file(
    new URL("../src/components/album/AlbumMasthead.astro", import.meta.url),
  ).text();
  const stylesheet = await Bun.file(new URL("../src/styles/album.css", import.meta.url)).text();
  const authScript = await Bun.file(
    new URL("../src/scripts/album-auth.js", import.meta.url),
  ).text();

  expect(masthead).toContain('class="album-signout-feedback"');
  expect(masthead).toContain('role="status"');
  expect(masthead).toContain('aria-live="polite"');
  expect(stylesheet).toContain(".album-signout-feedback:not([hidden])");
  expect(authScript).toContain("No se pudo cerrar la sesión. Inténtalo de nuevo.");
});
