/** Очередь заданий bcrypt в воркер-потоке (один воркер: второе ядро остаётся боям и старому серверу). */
import { Worker } from 'node:worker_threads';
import { logError } from '../log.ts';
import type { HashJob, HashResult } from './bcrypt-worker.ts';

type Pending = { resolve: (value: string | boolean) => void; reject: (error: Error) => void };

export class Hasher {
  private readonly workerUrl: URL;
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(workerUrl: URL) {
    this.workerUrl = workerUrl;
  }

  async hash(password: string, cost: number): Promise<string> {
    return (await this.run({ id: 0, op: 'hash', password, cost })) as string;
  }

  async check(password: string, hash: string): Promise<boolean> {
    return (await this.run({ id: 0, op: 'check', password, hash })) as boolean;
  }

  /** поднять воркер и прогнать bcrypt заранее, чтобы первый вход не ждал запуска потока и компиляции */
  async warmUp(): Promise<void> {
    await this.hash('warm-up', 4);
  }

  close(): void {
    void this.worker?.terminate();
    this.worker = null;
  }

  private run(job: HashJob): Promise<string | boolean> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ensureWorker().postMessage({ ...job, id });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerUrl);
    worker.on('message', (result: HashResult) => {
      const pending = this.pending.get(result.id);
      if (!pending) return;
      this.pending.delete(result.id);
      if (result.ok) pending.resolve(result.value);
      else pending.reject(new Error(result.error));
    });
    const fail = (error: Error): void => {
      if (this.worker !== worker) return;
      this.worker = null;
      logError('bcrypt', 'воркер остановился:', error.message);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code: number) => fail(new Error(`воркер bcrypt завершился с кодом ${code}`)));
    this.worker = worker;
    return worker;
  }
}
