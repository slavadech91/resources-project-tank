/**
 * Баны общие со старым сервером: `dev/bans.json` = {ник в нижнем регистре: окончание в секундах Unix, 0 — навсегда}
 * (chat_service.py). server2 читает файл при входе и пишет его командами /ban и /unban; формат тот же, истёкшие
 * записи чистит старый сервер.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';

export class BanList {
  private readonly file: string;
  private cache: Record<string, number> = {};
  private cacheTime = -1;

  constructor(file: string) {
    this.file = file;
  }

  /** окончание бана в мс (Infinity — навсегда) или null */
  bannedUntil(username: string, now = Date.now()): number | null {
    const until = this.read()[username.toLowerCase()];
    if (until === undefined) return null;
    if (until === 0) return Infinity;
    return until * 1000 > now ? until * 1000 : null;
  }

  /** /ban: вечный бан (seconds 0) или до now + seconds; запись в общий bans.json */
  set(username: string, seconds: number): void {
    const bans = { ...this.read() };
    bans[username.toLowerCase()] = seconds <= 0 ? 0 : Math.floor((Date.now() + seconds * 1000) / 1000);
    this.write(bans);
  }

  /** /unban: снять бан; false — записи не было */
  remove(username: string): boolean {
    const bans = { ...this.read() };
    if (!(username.toLowerCase() in bans)) return false;
    delete bans[username.toLowerCase()];
    this.write(bans);
    return true;
  }

  private write(bans: Record<string, number>): void {
    writeFileSync(this.file, JSON.stringify(bans, null, 2), 'utf8');
    this.cache = bans;
    try {
      this.cacheTime = statSync(this.file).mtimeMs;
    } catch {
      this.cacheTime = -1;
    }
  }

  private read(): Record<string, number> {
    try {
      const mtime = statSync(this.file).mtimeMs;
      if (mtime !== this.cacheTime) {
        const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        const bans: Record<string, number> = {};
        if (data && typeof data === 'object') {
          for (const [name, until] of Object.entries(data)) if (typeof until === 'number') bans[name.toLowerCase()] = until;
        }
        this.cache = bans;
        this.cacheTime = mtime;
      }
    } catch {
      // файла нет — банов нет
      this.cache = {};
      this.cacheTime = -1;
    }
    return this.cache;
  }
}
