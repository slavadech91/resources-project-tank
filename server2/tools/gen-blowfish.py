"""Начальные таблицы Blowfish (P-массив и S-блоки) — шестнадцатеричные цифры дробной части π.
Считает π по формуле Мэчина и пишет server2/src/auth/blowfishTables.ts. Запуск: python server2/tools/gen-blowfish.py"""
import os

WORDS = 18 + 4 * 256
DIGITS = WORDS * 8
GUARD = 16


def arctan_inv(x, one):
    total = term = one // x
    x2 = x * x
    n = 1
    sign = -1
    while term:
        term //= x2
        total += sign * (term // (2 * n + 1))
        sign = -sign
        n += 1
    return total


one = 16 ** (DIGITS + GUARD)
pi = 16 * arctan_inv(5, one) - 4 * arctan_inv(239, one)
fraction = (pi - 3 * one) >> (4 * GUARD)
digits = format(fraction, '0%dx' % DIGITS)
words = [int(digits[i * 8:i * 8 + 8], 16) for i in range(WORDS)]
# известные значения Blowfish: P1, P18, первый и последний элементы S-блоков
assert words[0] == 0x243F6A88 and words[17] == 0x8979FB1B
assert words[18] == 0xD1310BA6 and words[18 + 255] == 0x6E85076A
assert words[18 + 256] == 0x4B7A70E9 and words[-1] == 0x3AC372E6


def table(values):
    lines = []
    for i in range(0, len(values), 8):
        lines.append('  ' + ', '.join('0x%08x' % v for v in values[i:i + 8]) + ',')
    return '\n'.join(lines)


out = os.path.join(os.path.dirname(__file__), '..', 'src', 'auth', 'blowfishTables.ts')
with open(out, 'w', encoding='utf-8', newline='\n') as f:
    f.write('// Сгенерировано server2/tools/gen-blowfish.py: шестнадцатеричные цифры дробной части π (начальное состояние Blowfish).\n\n')
    f.write('/** P-массив, 18 слов */\nexport const P_INIT = Int32Array.from([\n%s\n]);\n\n' % table(words[:18]))
    f.write('/** четыре S-блока подряд, 4 × 256 слов */\nexport const S_INIT = Int32Array.from([\n%s\n]);\n' % table(words[18:]))
print('ok', len(words))
