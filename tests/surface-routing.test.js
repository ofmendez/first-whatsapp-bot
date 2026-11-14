import { expect, test } from "bun:test";
import { selectSurfaceFromRequestAuthority } from "@/src/surface-routing.js";

const surfaces = {
  panelOrigin: "https://admin.localhost:8443",
  albumOrigin: "https://album.localhost:8444",
};

test("public Host authority selects the matching surface over loopback HTTP upstream", () => {
  const admin = new Request("http://127.0.0.1:3008/", {
    headers: { Host: "admin.localhost:8443" },
  });
  const album = new Request("http://127.0.0.1:3008/", {
    headers: { Host: "album.localhost:8444" },
  });

  expect(selectSurfaceFromRequestAuthority(admin, surfaces)).toEqual({
    name: "admin",
    origin: surfaces.panelOrigin,
  });
  expect(selectSurfaceFromRequestAuthority(album, surfaces)).toEqual({
    name: "album",
    origin: surfaces.albumOrigin,
  });
});

test("authority matching rejects unknown hosts, wrong ports, and malformed authorities", () => {
  for (const host of [
    "unknown.localhost:8443",
    "admin.localhost:8444",
    "admin.localhost:3008",
    "admin.localhost:8443, album.localhost:8444",
    "admin.localhost:bad",
    "admin.localhost/path",
  ]) {
    const request = new Request("http://127.0.0.1:3008/", { headers: { Host: host } });
    expect(selectSurfaceFromRequestAuthority(request, surfaces)).toBeUndefined();
  }
});

test("forwarded headers cannot override an unknown request authority", () => {
  const request = new Request("http://unknown.localhost:8443/", {
    headers: {
      Host: "unknown.localhost:8443",
      Forwarded: "host=admin.localhost:8443;proto=https",
      "X-Forwarded-Host": "admin.localhost:8443",
      "X-Forwarded-Proto": "https",
    },
  });

  expect(selectSurfaceFromRequestAuthority(request, surfaces)).toBeUndefined();
});

test("conflicting non-loopback URL and Host authorities are rejected", () => {
  const request = new Request("http://admin.localhost:8443/", {
    headers: { Host: "album.localhost:8444" },
  });

  expect(selectSurfaceFromRequestAuthority(request, surfaces)).toBeUndefined();
});

test("implicit and explicit default HTTPS ports represent the same authority", () => {
  const defaultPortSurfaces = {
    panelOrigin: "https://admin.example.com",
    albumOrigin: "https://album.example.com",
  };
  const explicitPort = new Request("http://admin.example.com:443/", {
    headers: { Host: "admin.example.com:443" },
  });

  expect(selectSurfaceFromRequestAuthority(explicitPort, defaultPortSurfaces)).toEqual({
    name: "admin",
    origin: defaultPortSurfaces.panelOrigin,
  });
});
