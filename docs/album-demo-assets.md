# Album demo asset provenance

These assets are non-personal demonstration material. Only the licensed `park-walk` illustration is referenced by the application and emitted as public fingerprinted variants for the album login screen. The six other photographs below are retained as source/provenance material but are not imported or emitted into `dist/`. None is album content or a private-media delivery path; the real album does not load from public demo assets.

## Photographs

All seven photographs were downloaded from Pexels and retained as local WebP variants at 640px and 1280px wide using `ffmpeg`. Only `park-walk` is imported by the app, as the login illustration. The Pexels license permits free use on websites and apps, permits modification, and does not require attribution; credits are recorded here anyway. No photo is presented as an authentic memory or as an endorsement by the people shown.

| Local content key | Photographer | Source | Sample scene | Bundled variants |
| --- | --- | --- | --- | --- |
| `park-walk` | Cara Denison | [Pexels photo 37506905](https://www.pexels.com/photo/couple-walking-in-park-during-spring-day-37506905/) | A couple walking through a green park | `src/assets/album/park-walk-{640,1280}.webp` |
| `cafe-conversation` | Alex Green | [Pexels photo 5699508](https://www.pexels.com/photo/diverse-couple-drinking-coffee-together-in-cafe-5699508/) | A couple sharing coffee and conversation | `src/assets/album/cafe-conversation-{640,1280}.webp` |
| `mountain-view` | Yaroslav Shuraev | [Pexels photo 4762394](https://www.pexels.com/photo/a-couple-looking-at-the-mountain-view-4762394/) | Two hikers taking in a mountain view | `src/assets/album/mountain-view-{640,1280}.webp` |
| `lakeside-walk` | Boys in Bristol Photography | [Pexels photo 18314521](https://www.pexels.com/photo/couple-walking-on-pavement-along-pond-in-park-18314521/) | A couple walking by a park pond | `src/assets/album/lakeside-walk-{640,1280}.webp` |
| `home-cooking` | Helena Lopes | [Pexels photo 27176134](https://www.pexels.com/photo/couple-enjoying-cooking-together-in-modern-kitchen-27176134/) | A couple preparing breakfast together | `src/assets/album/home-cooking-{640,1280}.webp` |
| `street-cafe` | Katerina Holmes | [Pexels photo 5911266](https://www.pexels.com/photo/couple-sitting-in-street-cafe-with-cups-of-drink-5911266/) | A couple having coffee at an outdoor café | `src/assets/album/street-cafe-{640,1280}.webp` |
| `park-picnic` | SHVETS production | [Pexels photo 9048744](https://www.pexels.com/photo/couple-having-picnic-on-green-grass-9048744/) | An older couple sharing a book and picnic | `src/assets/album/park-picnic-{640,1280}.webp` |

License: [Pexels License](https://www.pexels.com/license/). Pexels permits use of its photos in websites and apps, allows editing, and does not require attribution. Its restrictions still apply, including no misleading endorsement and no redistribution as a stock-photo service.

## Font

- **Literata**, regular Latin WOFF2, served locally from `src/assets/album/Literata-latin.woff2`.
- Designed by the Literata Project authors; sourced from the [Google Fonts Literata project](https://github.com/googlefonts/literata) and its [Google Fonts distribution](https://github.com/google/fonts/tree/main/ofl/literata).
- Licensed under the [SIL Open Font License 1.1](licenses/Literata-OFL.txt). The font is bundled with the application, not fetched from a font CDN at runtime.

No third-party texture is bundled; paper surfaces and photo mats are styled locally with the supplied album tokens.
