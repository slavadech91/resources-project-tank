# Перенос физики танков из клиента 2014 года в HTML5 (TypeScript)

Инструкция для ИИ-агента. Цель — получить в браузере **ту же** физику, что в нашем Flash-клиенте 2014 года: езду, подвеску, скольжение, отдачу, столкновения. Не «похожую», а ту же: код переносится 1:1, а не пишется заново.

Общий контекст проекта — в [AGENTS.md](../AGENTS.md). Отвечай пользователю по-русски.

## 1. Главный принцип

- **Источник истины — наш клиент** (боевая библиотека, ресурс 42). Только в нём точная версия физики 2014 года: в нём есть `alternativa.physics.contactislands`, `ShapeContact`, `BodyContact`, которых нет ни в одной из 22 версий архива AlternativaPhysics и нет в демо Tanki 2.0.
- **Читаемые исходники** (демо 2.0 и архив физики) — только справочник, чтобы понять, что делает код и как называются поля. Код из них не копировать: версия другая. Например, в демо ходовая — `LegacySuspensionRay` (трение считается внутри луча), а у нас `SuspensionRay` + `Track` + `TrackedChassis` (трение вынесено в гусеницу).
- **Ничего не улучшать.** Никаких «оптимизаций», упрощений, замены формул на «правильные», готовых физических движков (Rapier, cannon, ammo). Ошибка в одной константе или порядке операций меняет «ощущение» танка, и это очень трудно заметить.
- **Рендер не переносить.** Alternativa3D заменяется на Three.js. Физика живёт отдельно от графики и ничего о ней не знает.

## 2. Что уже есть в проекте

| Что | Где |
|---|---|
| Боевая библиотека (физика, танк, оружие, режимы) | `client/tanki_2014_client/resources/0/0/0/42/1/library*.swf`; оригиналы без патчей — `patch/library-debug.orig.swf`, `patch/library.orig.swf` |
| Декомпиляция FFDec (обфусцированные имена `§#!R§`) | `decompiled/field_all/scripts/` |
| Таблица имён: обфусцированный класс → настоящее имя, путь файла FFDec, настоящие имена методов, список полей | `docs/deobf/battle_library.json` (делает `tools/deobf_map.py`) |
| **Читаемая копия** — настоящие имена пакетов, классов, методов и известных полей | `decompiled/field_readable/` (делает `tools/deobf_copy.py`), например `decompiled/field_readable/alternativa/tanks/battle/objects/tank/SuspensionRay.as` |
| Имена полей, найденные вручную | `docs/deobf/field_names.json` (пока заполнены `Vector3`, `Quaternion`, `Matrix3`, `Matrix4`) |

Откуда настоящие имена: в `library-debug.swf` у каждого метода сохранено отладочное имя вида `alternativa.tanks.battle.objects.tank:SuspensionRay/calculateSpringForce`. FFDec его не показывает, а `tools/deobf_map.py` читает. Из 929 классов настоящее имя найдено у 928. У полей отладочных имён нет — их приходится восстанавливать вручную (раздел 5).

Пересоздать таблицу и читаемую копию (например, после пополнения `field_names.json`):

```bash
python tools/deobf_map.py patch/library-debug.orig.swf docs/deobf/battle_library.json
python tools/deobf_copy.py docs/deobf/battle_library.json decompiled/field_all/scripts decompiled/field_readable docs/deobf/field_names.json
```

Особенности читаемой копии:
- 925 из 929 файлов. 3 файла с именами-ключевыми словами (`native`, `set`) и один служебный не сопоставились — их ищи в `field_all` по пути из `battle_library.json`.
- Первая строка каждого файла — путь исходного файла FFDec.
- Обфускатор даёт одному имени один и тот же токен во всех классах. Поэтому найденное имя поля работает везде. Но 39 токенов означают разные методы в разных классах: такие внутри класса переименованы правильно (по таблице самого класса), а в вызовах на чужих объектах остались токенами. Их определяй по типу объекта.
- Геттеры часто остаются токенами: например, `§'!W§` — это геттер `state` (`body.state`). Их можно добавить в `field_names.json`.

## 3. Читаемые справочники (скачивать в отдельную папку, например `assets/physics_ref/`)

- [MapMakersAndProgrammers/TankiOnline2.0DemoClient](https://github.com/MapMakersAndProgrammers/TankiOnline2.0DemoClient) — `src/alternativa/math`, `src/alternativa/physics` (тела, сцена, коллайдеры, kd-дерево), `src/alternativa/tanks/game/entities/tank/physics/chassis/tracked/legacy/` (ходовая). Часть полей там тоже названа `name_XX`, но классы, методы и логика читаемы.
- [MapMakersAndProgrammers/alternativaphysics-archive](https://github.com/MapMakersAndProgrammers/alternativaphysics-archive) — 22 версии AlternativaPhysics (0.0.0.18 … 2.0.1.0). Коллайдеры (`BoxBoxCollider`, `BoxTriangleCollider` и др.) и kd-дерево по алгоритму близки к нашим. Хорошо подходят, чтобы узнать имена полей.

## 4. Что переносить и в каком порядке

Классы — по настоящим именам; файлы лежат в `decompiled/field_readable/<пакет>/<Класс>.as`. Всего около 80 классов и 11 тысяч строк AS3.

| Шаг | Классы | Зачем |
|---|---|---|
| 1. Математика | `alternativa.math.Vector3`, `Matrix3`, `Matrix4`, `Quaternion` | основа всего; поля уже названы |
| 2. Типы и примитивы столкновений | `alternativa.physics.collision.types.{AABB, Ray, RayHit}`, `alternativa.physics.collision.{CollisionShape, ICollisionFilter, IRayCollisionFilter, BodyCollisionFilter, Collider, CollisionDetector}`, `alternativa.physics.collision.primitives.{CollisionBox, CollisionRect, CollisionSphere, CollisionTriangle}` | геометрия карты и танка |
| 3. Коллайдеры | `alternativa.physics.collision.colliders.{BoxBoxCollider, BoxRectCollider, BoxSphereCollider, BoxTriangleCollider, ColliderUtils, PolygonsIntersectionUtils, FaceSide, Vertex}` | точки контакта |
| 4. Пространственное дерево | `alternativa.physics.collision.{CollisionKdNode, CollisionKdTree, CollisionKdTree2D}`, `alternativa.tanks.physics.TanksCollisionDetector` (**настоящий детектор игры**, 739 строк), `alternativa.tanks.physics.{CollisionGroup, MinMax, SweptSphereTest}` | лучи подвески и столкновения с картой |
| 5. Тела и сцена | `alternativa.physics.{Body, BodyState, BodyList, BodyListItem, BodyContact, ShapeContact, PhysicsMaterial, PhysicsUtils, QuickUnionFind, PhysicsScene}`, `alternativa.physics.contactislands.{ContactIsland, ContactLevels, IslandsGenerator}`, `alternativa.physics.constraints.Constraint` | интеграция, решение контактов |
| 6. Тело танка | `alternativa.tanks.physics.{TankBody, TankBodyIdProvider}`, `alternativa.tanks.battle.objects.tank.CollisionBoxesBuilder` | коробки столкновений корпуса |
| 7. Ходовая | `alternativa.tanks.battle.objects.tank.{SuspensionParams, SuspensionRay, Track, TrackedChassis, RayCollisionFilter}` | **«ощущение» езды**: подвеска, трение, скольжение, повороты |
| 8. Управление | `ChassisController`, `LocalChassisController`, `TurretController`, `LocalTurretController`, `WeaponPlatform` (пакет `alternativa.tanks.battle.objects.tank`) | клавиши → силы, поворот башни |
| 9. Танк и цикл | `alternativa.tanks.battle.objects.tank.Tank` (только физическая часть), `alternativa.tanks.battle.{BattleRunner, PhysicsController, PhysicsInterpolator}` | фиксированный шаг физики, интерполяция для отрисовки |
| 10. Сеть движения | `alternativa.tanks.models.tank.{MoveCommandUtils}`, `alternativa.tanks.models.tank.codec.{MoveCommandCodec, BitArea}`, `alternativa.tanks.battle.objects.tank.{RemoteHullTransformUpdater, LocalHullTransformUpdater, SimpleValueSmoother, ValueSmoother}` | синхронизация чужих танков без дёрганья |

После ходовой — отдача и удары: `alternativa.tanks.models.weapon.{WeaponForces, WeaponConst, WeaponUtils}` и модели конкретных пушек (`alternativa.tanks.models.weapon.smoky`, `.plasma` — это Twins, `.thunder`, `.railgun` и т. д.).

**Не переносить:**
- антихит: `alternativa.tanks.utils.Encrypted*`, `ConstEncryptedNumber`, `EncryptedValueSmoother`, `DataValidator*`, `*Validator`, `SpeedHackChecker`, `BodyPhysicsStateValidator`, пакет `cheatsemulation`. `EncryptedNumber`/`EncryptedInt` заменяй обычным `number`, а значения бери из конструктора (`new EncryptedIntImpl(33)` → `33`);
- графику: `alternativa.engine3d.*`, `TankSkin*`, `*Material*`, `TracksAnimator`, `alternativa.tanks.sfx` — это делается на Three.js отдельно.

## 5. Как восстанавливать имена полей

Поля без имён — главная ручная работа. Порядок действий для каждого класса:

1. Открой наш класс в `field_readable` и его аналог в справочнике (демо или архив, ближайшая версия).
2. Сопоставь поля:
   - **по порядку объявления и типам** — компилятор сохраняет порядок; так найдены поля `Vector3` и `Matrix3`;
   - **по конструктору** — какой параметр в какое поле записывается;
   - **по использованию** — в каких формулах участвует поле (например, `rayLength - hit.t` — это длина луча подвески);
   - **по значениям по умолчанию** — у `SuspensionParams` это `50`, `25`, `0`, `1000`; сравни с аналогом в справочнике.
3. Запиши в `docs/deobf/field_names.json`: токен без знаков `§` → имя. В `_sources` укажи, откуда взято имя. Если не уверен — дай описательное имя с пометкой (`unknownSpringDamping_guess`), а не выдумывай уверенное.
4. Перезапусти `tools/deobf_copy.py`. Имя появится во всех классах сразу.

Токен одинаков во всех классах, поэтому поле, найденное один раз (например, `position` у `BodyState`), читается везде.

## 6. Правила перевода AS3 → TypeScript

- Переводи **строка в строку, в том же порядке**. Сохраняй порядок арифметических операций: от него зависит округление чисел с плавающей точкой.
- `Number` → `number`. `int`/`uint` → `number`, но там, где важна целочисленность (деление, сдвиги, переполнение), добавляй `| 0` или `>>> 0`.
- `Vector.<T>` → `T[]`. `for each (x in v)` → `for (const x of v)`. Если в коде `v.length = 0`, оставь так же.
- Статические временные объекты (`private static var _v:Vector3`) оставляй как есть. Это пул объектов против сборщика мусора, и он нужен и в JS.
- Геттеры и сеттеры AS3 → `get`/`set` TypeScript.
- Артефакты FFDec (`_loc1_`, лишние `Number(...)`, `param1`) переименовывай в осмысленные имена, но логику не трогай.
- Если метод выглядит странно или нелогично, проверь его в p-code: FFDec иногда ошибается при декомпиляции (`ffdec-cli -export pcode`, путь к Java — в AGENTS.md).
- Единицы как в оригинале: сантиметры, секунды, система координат с осью Z вверх. Переход к Three.js (ось Y вверх) — только в слое отрисовки.
- Шаг физики фиксированный. В `BattleRunner` есть константа `EncryptedIntImpl(33)` — это, судя по всему, шаг 33 мс. Проверь по коду `BattleRunner` и `PhysicsScene.update`. Отрисовку делай с интерполяцией (`PhysicsInterpolator`), а не меняй шаг физики под частоту кадров.

## 7. Откуда брать параметры

- Корпуса и пушки: `dev/configs/garage_items/hulls.json` и `turrets.json` (уже взяты из оригинала). Клиент умножает серверные значения на 100 (метры → сантиметры). Найди, где именно параметры корпуса попадают в `TrackedChassis` и `SuspensionParams` (через `Tank` и модели танка), и повтори то же преобразование.
- Гравитация — поле `gravity` в `dev/configs/maps.json`.
- Геометрия столкновений карты — `dev/configs/maps/map_<name>.xml` (`collision-geometry`: `collision-box`, `collision-plane` = `CollisionRect`, `collision-triangle`).
- Коробки столкновений корпуса — из 3ds-модели корпуса (`CollisionBoxesBuilder`).

## 8. Как проверять, что физика та же

1. **Модульные тесты на каждый шаг** (Vitest или Jest): для математики и коллайдеров — известные случаи (коробка на плоскости, треугольник под коробкой, луч в треугольник).
2. **Эталонные трассы из оригинала — главный способ.** Пропатчи `TrackedChassis`/`Tank` в боевой библиотеке (как уже делалось для трассировок Twins: `ffdec-cli -replace`, см. AGENTS.md). Пусть на каждом шаге физики пишется `trace` с позицией, ориентацией, скоростью и угловой скоростью танка и нажатыми клавишами. Запиши в `flashlog.txt` несколько заездов: разгон по прямой, разворот на месте, поворот на ходу, съезд со склона, наезд на стену, выстрел Smoky стоя. Затем прогони в TypeScript-версии ту же последовательность клавиш с тем же стартом и сравни трассы. Расхождение в первых кадрах — ошибка перевода; ищи первый шаг, где числа разошлись.
3. Только после этого — сравнение «на ощущение» пользователем: Flash-клиент и новый клиент рядом на одной карте.

## 9. Шаблон задачи для агента на один класс

> Переведи `decompiled/field_readable/<путь>.as` в TypeScript (`<куда>.ts`) строго 1:1: тот же порядок операций, те же константы, никаких упрощений и «улучшений». Неизвестные поля (`§..§`) сначала попробуй назвать по справочнику `<путь в справочнике>` и запиши их в `docs/deobf/field_names.json` с источником; если не получается — оставь описательное имя с `_guess`. `Encrypted*` замени на `number`. Зависимости импортируй из уже перенесённых модулей. Напиши тест на <случай> и покажи, какие места кода вызывают сомнения.

## 10. Чек-лист

- [ ] Таблица и читаемая копия пересозданы, `field_names.json` пополняется.
- [ ] Математика перенесена и покрыта тестами.
- [ ] Примитивы, коллайдеры, kd-дерево, `TanksCollisionDetector` перенесены; луч и коробка правильно сталкиваются с геометрией карты из XML.
- [ ] `Body`, `PhysicsScene`, острова контактов: коробка падает и спокойно лежит на плоскости, не дрожит и не проваливается.
- [ ] Ходовая: танк стоит на подвеске, едет, поворачивает; трассы совпадают с эталонными из Flash-клиента.
- [ ] Шаг 33 мс и интерполяция отрисовки.
- [ ] Отрисовка в Three.js, ось Z → Y только в отрисовке.
- [ ] Сеть движения: чужой танк движется плавно.
- [ ] Пользователь сравнил «на ощущение» с Flash-клиентом.
