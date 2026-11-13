
## Рендер html5 (ветка overhaul, шаг 1: RenderCore + FrameGraph)

Ветка разработки — `~/project-overhaul` на Debian (своя БД `tanki_overhaul`, порты 5190/5291, службы `tanki-overhaul-*`); оригинал `~/tanki` не трогаем.

- Ядро: `html5/src/render/RenderCore.ts` — единственный владелец `WebGLRenderer`, сцены, камеры, размера буфера и графа кадров; `render(dynamicShadows, camera?)` обновляет паспорт кадра и прогоняет проходы.
- Граф: `src/render/frame/FrameGraph.ts` (`RenderPass { name, enabled, render(ctx) }`), цели — `frame/RenderTargets.ts` (глубина 0.5× и буфер SSAO, пересоздаются по размеру).
- Проходы `src/render/passes/`: `layers`, `ambient-shadows`, `scene-full`, `depth`, `soft-particles`, `ssao-compute`, `scene-opaque`, `ssao-apply`, `scene-transparent`, `finish`. Порядок совпадает с прежним порядком операций `BattleRenderer.render`; включаются по настройкам эффектов каждый кадр (по умолчанию `enabled = false`).
- `BattleRenderer` — фасад: `setSettings`, `setMapParams`, туман, тень под танком, динамический свет; `makeSoftParticle`/`softUniforms` реэкспортируются из него (sfx-модули не менялись).
- Сборка только локально (на Debian нет npm/pnpm): `node node_modules/typescript/bin/tsc --noEmit`, затем `node node_modules/vite/bin/vite.js build`; на сервер кладутся `dist/index.html` + `dist/assets`, затем `sudo systemctl restart tanki-overhaul-web`.
- Рантайм-проверка без глаз: headless Edge + CDP (`Runtime.enable`, `Page.navigate`), читаем `window.__tanki.frameGraph.all` (имена и `enabled`) и `window.__tanki.renderer.info.render`. Режим по умолчанию — только `scene-full`; при `localStorage['tanki.graphics'] = {"softParticles":true,"ssao":true,"shadows":true,"fog":true,"dynamicLighting":true}` — полный набор проходов. Оба режима дают 0 ошибок JS.
- Страница для проверки: http://127.0.0.1:5180/.
