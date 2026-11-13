/**
 * Самопроверка bcrypt server2: хеши, сделанные Python `bcrypt` (как у старого сервера), должны проверяться, а свой хеш —
 * совпадать с ними при той же соли; затем замер стоимости 12 (вход и регистрация).
 * Локально: node server2/tools/bcrypt-check.ts. На Debian (Node 18): node server2/build.mjs собирает dist/bcrypt-check.mjs.
 */
import { checkPassword, hashPassword } from '../src/auth/bcrypt.ts';

/** [пароль, хеш Python bcrypt 5.0.0]; 50 «Ж» = 100 байт и 72 «A» — обрезка ключа до 72 байт */
const VECTORS: [string, string][] = [
  ['a', '$2b$04$Wf/Snj0uHbK7zn2FXgK4C.FGUSfJv/Zsz0n/r3AutBznpCmHepbmu'],
  ['password', '$2b$05$0OoQ4MP9nG2raBjAndeEe.LhCImNS35jilRYmd7kGU5TgfGaPNDGK'],
  ['пароль123', '$2b$05$EolPLrip43uy00mdfDH8M.7R7TL13MEAg6fcBGpydax.nuA4Nh58W'],
  ['Ж'.repeat(50), '$2b$05$I0GOPeip6LeSOjQsulpbQ.31iL0gybBzJ7mPhpw9NdcM884uO7MY2'],
  ['', '$2b$04$qjLPv/jlnL4Brr8JgpxuL.2/t4U5shrA5VHdJn.igzqTUBiYg6DHS'],
  ['A'.repeat(71), '$2b$04$08JEW7t4Tyy9Yt7pS7XxsenMJSm22zQ9.y7oYVzu4o/tOZIuf/tZ6'],
  ['A'.repeat(72), '$2b$04$.gFb1zzOaSnQ.MV3.bxQjeJMRT5xEbcZQhjoZx1CYnHyJICQilnfe'],
];

const ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** соль из хеша обратно в 16 байт — чтобы сравнить свой хеш с эталоном целиком */
function saltOf(hash: string): Uint8Array {
  const text = hash.slice(7, 29);
  const out = new Uint8Array(16);
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of text) {
    value = (value << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8 && o < 16) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

let failures = 0;
for (const [password, hash] of VECTORS) {
  const cost = Number(hash.slice(4, 6));
  const long = new TextEncoder().encode(password).length >= 72;
  const ok = checkPassword(password, hash) && (long || !checkPassword(password + '!', hash));
  const same = hashPassword(password, cost, saltOf(hash)) === hash;
  if (!ok || !same) failures++;
  console.log(`${ok && same ? 'OK  ' : 'FAIL'} ${JSON.stringify(password.length > 12 ? password.slice(0, 6) + '…' : password)} (${new TextEncoder().encode(password).length} байт)`);
}
if (checkPassword('password', '$2b$05$0OoQ4MP9nG2raBjAndeEe.LhCImNS35jilRYmd7kGU5TgfGaPNDGL')) {
  failures++;
  console.log('FAIL изменённый хеш принят');
}
for (let n = 0; n < 3; n++) {
  const started = performance.now();
  const hash = hashPassword('password', 12);
  console.log(`стоимость 12: ${Math.round(performance.now() - started)} мс${checkPassword('password', hash) ? '' : ' FAIL'}`);
}
console.log(failures ? `Ошибок: ${failures}` : 'bcrypt совпадает с Python');
process.exit(failures ? 1 : 0);
