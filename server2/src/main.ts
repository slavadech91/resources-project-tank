/** server2 — точка входа: конфиги, база, bcrypt-воркер, HTTP-сервер с WebSocket на WS_PATH. */
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { WS_PATH } from '../../html5/src/net2/protocol.ts';
import { App } from './app.ts';
import { BanList } from './auth/bans.ts';
import { loadMapData } from './battle/mapData.ts';
import { Hasher } from './auth/hasher.ts';
import { loadConfig } from './config.ts';
import { Database } from './db/mysql.ts';
import { loadMaps } from './game/maps.ts';
import { GarageCatalog } from './garage/catalog.ts';
import { GarageService } from './garage/garage.ts';
import { BattleRegistry } from './lobby/battles.ts';
import { log, logError } from './log.ts';
import { acceptWebSocket } from './net/websocket.ts';

import { initMissions } from './lobby/missions.ts';

const MAX_CONNECTIONS = 500;

async function main(): Promise<void> {
  const config = loadConfig();
  const maps = loadMaps(config.configDir);
  const db = new Database(config.db);
  await db.query('SELECT 1');
  await initMissions(db);
  log('db', `MariaDB ${config.db.host}:${config.db.port}/${config.db.database} — подключено`);
  const battles = new BattleRegistry(db, maps);
  await battles.load();
  const catalog = new GarageCatalog(config.configDir);
  log('garage', `предметов: ${catalog.items.size}`);
  const garage = new GarageService(db, catalog, config.startingItems);
  await garage.appearances.init();
  const hasher = new Hasher(new URL('./bcrypt-worker.mjs', import.meta.url));
  await hasher.warmUp();
  const mapData = loadMapData(config.configDir);
  log('battle', `карт для боёв: ${mapData.size} (${[...mapData.values()].map((map) => `${map.key}: ${map.spawns.dm.length}/${map.spawns.red.length}/${map.spawns.blue.length}`).join(', ')})`);
  const app = new App({ config, db, hasher, bans: new BanList(join(config.devDir, 'bans.json')), maps, battles, garage, mapData });

  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(app.stats()));
      return;
    }
    response.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`server2: WebSocket на ${WS_PATH}`);
  });
  server.on('upgrade', (request, socket: Socket, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const path = (request.url ?? '').split('?')[0];
    if (path !== WS_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (app.sessionCount >= MAX_CONNECTIONS) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(request, socket, head);
    if (ws) app.addSession(ws);
  });
  server.on('error', (error: Error) => {
    logError('http', error.message);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => log('http', `ws://${config.host}:${config.port}${WS_PATH} (dev: ${config.devDir})`));

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log('main', `${signal}: остановка`);
    app.shutdown();
    server.close();
    hasher.close();
    void db.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

process.on('unhandledRejection', (error: unknown) => logError('main', 'необработанная ошибка:', error));
main().catch((error: unknown) => {
  logError('main', 'запуск не удался:', error);
  process.exit(1);
});
