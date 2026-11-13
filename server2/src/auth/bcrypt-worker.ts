/** Воркер bcrypt: хеширование и проверка паролей вне потока событий сервера. */
import { parentPort } from 'node:worker_threads';
import { checkPassword, hashPassword } from './bcrypt.ts';

export type HashJob = { id: number; op: 'hash'; password: string; cost: number } | { id: number; op: 'check'; password: string; hash: string };
export type HashResult = { id: number; ok: true; value: string | boolean } | { id: number; ok: false; error: string };

parentPort?.on('message', (job: HashJob) => {
  let result: HashResult;
  try {
    result = { id: job.id, ok: true, value: job.op === 'hash' ? hashPassword(job.password, job.cost) : checkPassword(job.password, job.hash) };
  } catch (error) {
    result = { id: job.id, ok: false, error: String(error) };
  }
  parentPort?.postMessage(result);
});
