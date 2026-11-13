# Киллфид Narukami

Источник: client/game/src/alternativa/tanks/models/battle/gui/gui/statistics/messages/{BattleMessages,BattleMessagesOutput,KillMessageOutputLine,ActionOutputLine}.as и battlefield/common/{MessageLine,MessageContainer}.as. Исходные PNG копирует tools/export_narukami_killfeed.py без изменения; sources.json содержит SHA256.

HTML5 server2: справа6px, сверху50px,10строк, отступ6px,30секунд жизни +1секунда ступенчатого затухания. Иконки оружия26×26, маленькие оригинальные звания, Tahoma12, командные цвета из MessageColor/ColorConstants. Самоуничтожение имеет отдельную исходную иконку. CSS-тень приближает Flash GlowFilter, растеризация шрифта зависит от браузера. Подключено к S2Battle, очищается при рестарте и выходе. Сервер передаёт тип оружия, включая mine; баланс не меняется. Легаси Python/Flash не изменялся. Проверку внешнего вида в живом бою делает пользователь.
