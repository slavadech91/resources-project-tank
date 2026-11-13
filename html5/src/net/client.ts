/**
 * Клиент игрового протокола (main-канал + каналы пространств).
 *
 * Схема сообщений повторяет сервер juhe1 дословно:
 *  главный канал: byte команда -> параметры;
 *  канал пространства: long object_id -> long command_id -> параметры,
 *  объекты приходят командой 100000 (LoadObjects) у объекта-диспетчера.
 */

import { ByteReader, ByteWriter, PackageStream, wrapPackage } from './bytes.ts';
import { decodeValue } from './codec.ts';
import { SCHEMA } from './schema-data.ts';
import type { CommandEntry, ModelDataEntry } from './schema.ts';

export const BASIC_COMMAND = {
  CL_HASH_REQUEST: 1,
  SV_HASH_RESPONSE: 2,
  SV_COMMAND_REQUEST: 9,
  CL_COMMAND_RESPONSE: 10,
  SV_OPEN_SPACE: 32,
  CL_LOG: 32,
  SV_LOAD_DEPENDENCIES: 33,
  CL_DEPENDENCIES_LOADED: 33,
  SV_UNLOAD_DEPENDENCIES: 34,
  SV_MESSAGE: 35,
} as const;

export const DISPATCHER_COMMAND = {
  LOAD_OBJECTS: 100000,
  UNLOAD_OBJECTS: 100001,
} as const;

export const MODEL_ID = {
  ENTRANCE: 300020011,
  LOGIN: 300020020,
  REGISTRATION: 300020025,
  USER_PROPERTY: 300050071,
  LOBBY_LAYOUT: 300070010,
  TANK: 300100078,
  BATTLE_FIELD: 300100008,
  BATTLE_MAP: 300100005,
} as const;

export const LOGIN_COMMAND_ID = 300020048;
/** чат html5 и права администратора (chat_service.py сервера), в протоколе 2014 их нет */
export const CHAT_COMMAND = { SEND: 390000010, MESSAGE: 390000011, ADMIN_STATE: 390000012 };
export const CHAT_KIND = { PLAYER: 0, SYSTEM: 1, REPLY: 2 };

export interface ChatMessage {
  author: string;
  rank: number;
  kind: number;
  text: string;
}
export const REGISTER_COMMAND_ID = 300020061;
export const WRONG_PASSWORD_COMMAND_ID = 300020049;

const SPACE_NAMES: Record<number, string> = {
  1: 'entrance',
  2: 'lobby',
  3: 'garage',
  4: 'battle_select',
};

/** id пространства боя = id боя + BATTLE_SPACE_ID_OFFSET (см. battle_item_global_model.py). */
const BATTLE_SPACE_ID_OFFSET = 200;

export function spaceNameById(spaceId: number): string {
  if (spaceId >= BATTLE_SPACE_ID_OFFSET) return `battle_field_${spaceId - BATTLE_SPACE_ID_OFFSET}`;
  return SPACE_NAMES[spaceId] ?? `space_${spaceId}`;
}

/** Тип пространства в терминах папок client/layouts (по нему выбирается схема модели). */
export function spaceKind(name: string): string {
  if (name.startsWith('battle_field')) return 'battle';
  return name;
}

export interface Transport {
  send(data: Uint8Array): void;
  close(): void;
  onData: ((data: Uint8Array) => void) | null;
  onClose: (() => void) | null;
}

export type ConnectFn = (host: string, port: number) => Promise<Transport>;

export interface RemoteObject {
  id: number;
  classId: number;
  /** model ids класса (см. SV_LOAD_DEPENDENCIES) */
  modelIds: number[];
  /** данные моделей из LoadObjects: model_id -> разобранные поля */
  models: Map<number, unknown>;
  /** performance.now() при получении: остатки времени (time_left) отсчитываются от этого момента, а не от конца загрузки боя */
  loadedAt: number;
}

export interface UserInfo {
  uid: string;
  userId: number;
  crystals: number;
  rank: number;
  score: number;
  nextRankScore: number;
}

export interface ClientEvents {
  log: string;
  chat: ChatMessage;
  /** сервер сообщил права после входа (ADMIN_STATE) */
  admin: boolean;
  hash: { size: number; usesXor: boolean };
  space: { id: number; name: string };
  /** сервер закрыл пространство (смена раздела лобби: battle_select / garage) */
  'space-closed': { id: number; name: string };
  objects: { spaceId: number; spaceName: string; added: RemoteObject[] };
  /** UNLOAD_OBJECTS: объекты убраны из пространства (игрок вышел из боя) */
  unloaded: { spaceId: number; spaceName: string; ids: number[] };
  /**
   * Команда модели от сервера. name/model/args — по схеме из *_model_commands.py;
   * если схемы нет или разбор не сошёлся, name = null и args = null.
   */
  command: {
    spaceId: number;
    spaceName: string;
    objectId: number;
    commandId: number;
    bytes: number;
    model: number | null;
    name: string | null;
    args: unknown;
  };
  resource: {
    id: number;
    type: number;
    version: number;
    isLazy: boolean;
    hashMethod: number;
    locales: string[];
    files: { name: string; size: number }[];
    params: Record<string, string> | null;
  };
  user: UserInfo;
  'login-ok': { username: string };
  'login-failed': { username: string };
  error: { message: string; error?: unknown };
}

export interface GameClientOptions {
  connect: ConnectFn;
  host?: string;
  mainPort?: number;
  lang?: string;
  locale?: string;
  configUrl?: string;
  /** как представиться серверу в хэш-запросе (html5 -> сервер не шлёт SWF-ресурсы) */
  clientKind?: string;
}

export interface RemoteSpace {
  id: number;
  name: string;
  transport: Transport | null;
  stream: PackageStream;
  objects: Map<number, RemoteObject>;
}

export class GameClient {
  private readonly options: Required<GameClientOptions>;
  private readonly stream = new PackageStream();
  private readonly spaces = new Map<number, RemoteSpace>();
  private readonly classes = new Map<number, number[]>();
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  private main: Transport | null = null;
  /** администратор: создаёт бои, команды чата */
  isAdmin = false;
  private hash: Uint8Array | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: GameClientOptions) {
    this.options = {
      connect: options.connect,
      host: options.host ?? '127.0.0.1',
      mainPort: options.mainPort ?? 1212,
      lang: options.lang ?? 'ru',
      locale: options.locale ?? 'ru',
      configUrl: options.configUrl ?? 'http://127.0.0.1:8000/config.xml',
      clientKind: options.clientKind ?? 'html5',
    };
  }

  on<K extends keyof ClientEvents>(name: K, handler: (payload: ClientEvents[K]) => void): void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as (payload: unknown) => void);
  }

  off<K extends keyof ClientEvents>(name: K, handler: (payload: ClientEvents[K]) => void): void {
    this.handlers.get(name)?.delete(handler as (payload: unknown) => void);
  }

  /**
   * Свои команды сервера вне схемы протокола 2014 (SHOT_ACK, HEALTH_STATE из shot_registry сервера): обработчик
   * получает читатель сразу после id команды. Возвращает функцию отписки.
   */
  onRawCommand(commandId: number, handler: (spaceName: string, objectId: number, reader: ByteReader) => void): () => void {
    this.rawHandlers.set(commandId, handler);
    return () => {
      if (this.rawHandlers.get(commandId) === handler) this.rawHandlers.delete(commandId);
    };
  }

  private readonly rawHandlers = new Map<number, (spaceName: string, objectId: number, reader: ByteReader) => void>();

  private fire<K extends keyof ClientEvents>(name: K, payload: ClientEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (error) {
        console.error('обработчик события упал', name, error);
      }
    }
  }

  private log(message: string): void {
    this.fire('log', message);
  }

  /** Все сетевые данные обрабатываем строго по очереди: разбор пакетов асинхронный (zlib). */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.fire('error', { message: 'ошибка обработки пакета', error });
    });
  }

  async connect(): Promise<void> {
    const transport = await this.options.connect(this.options.host, this.options.mainPort);
    this.main = transport;
    transport.onData = (data) => {
      this.enqueue(async () => {
        const packets = await this.stream.push(data);
        for (const packet of packets) await this.handleBasicPacket(packet);
      });
    };
    transport.onClose = () => {
      this.closed = true;
      this.log('соединение с сервером закрыто');
    };

    const writer = new ByteWriter();
    writer.u8(BASIC_COMMAND.CL_HASH_REQUEST);
    // VectorLevel1Codec<StringCodec> для ключей и значений запроса
    const keys = ['config', 'lang', 'locale', 'client'];
    const values = [this.options.configUrl, this.options.lang, this.options.locale, this.options.clientKind];
    writer.writeLength(keys.length);
    for (const key of keys) writer.str(key);
    writer.writeLength(values.length);
    for (const value of values) writer.str(value);

    transport.send(wrapPackage(writer));
    this.log(`запрос хэша отправлен (${this.options.host}:${this.options.mainPort})`);
  }

  close(): void {
    this.closed = true;
    for (const space of this.spaces.values()) space.transport?.close();
    this.main?.close();
  }

  // ------------------------------------------------------------- главный канал
  private async handleBasicPacket(reader: ByteReader): Promise<void> {
    const type = reader.u8();
    switch (type) {
      case BASIC_COMMAND.SV_HASH_RESPONSE: {
        this.hash = reader.bytes(32).slice();
        const usesXor = reader.bool();
        this.fire('hash', { size: this.hash.length, usesXor });
        this.log(`хэш клиента получен (${this.hash.length} байт, xor=${usesXor})`);
        return;
      }
      case BASIC_COMMAND.SV_OPEN_SPACE: {
        const id = reader.i64();
        const ip = reader.str();
        const count = reader.u8();
        const ports: number[] = [];
        for (let index = 0; index < count; index += 1) ports.push(reader.i32());
        await this.openSpace(id, ip, ports[0] ?? 1213);
        return;
      }
      case BASIC_COMMAND.SV_LOAD_DEPENDENCIES: {
        this.readDependencies(reader);
        this.sendDependenciesLoaded();
        return;
      }
      case BASIC_COMMAND.SV_UNLOAD_DEPENDENCIES: {
        this.sendDependenciesLoaded();
        return;
      }
      case BASIC_COMMAND.SV_MESSAGE: {
        this.log(`сообщение сервера: ${reader.remaining} байт`);
        return;
      }
      default: {
        this.log(`неизвестная basic-команда ${type} (${reader.remaining} байт)`);
      }
    }
  }

  private sendDependenciesLoaded(): void {
    const writer = new ByteWriter();
    writer.u8(BASIC_COMMAND.CL_DEPENDENCIES_LOADED);
    this.main?.send(wrapPackage(writer));
  }

  /** SV_LOAD_DEPENDENCIES: классы (id моделей) и ресурсы клиента. */
  private readDependencies(reader: ByteReader): void {
    const count = reader.i32();
    for (let index = 0; index < count; index += 1) {
      const itemType = reader.u8();
      if (itemType === 3) continue;
      if (itemType === 2) {
        this.readResource(reader);
        continue;
      }
      if (itemType !== 1) {
        this.log(`неизвестный тип зависимости ${itemType} — дальше пакет не читаю`);
        return;
      }
      const classId = reader.i64();
      const hasParent = !reader.readOptionalBit();
      const parentId = hasParent ? reader.i64() : 0;
      const modelCount = reader.i32();
      const modelIds: number[] = [];
      for (let modelIndex = 0; modelIndex < modelCount; modelIndex += 1) modelIds.push(reader.i64());
      const dataLength = reader.i32();
      reader.i16(); // смещение данных моделей, всегда 0
      if (dataLength > 0) reader.bytes(dataLength);
      this.classes.set(classId, modelIds);
      this.log(`класс ${classId}: модели [${modelIds.join(', ')}]${hasParent ? `, родитель ${parentId}` : ''}`);
    }
  }

  /** Ресурс клиента (SWF-библиотека, картинка, карта и т.д.) — только для диагностики. */
  private readResource(reader: ByteReader): void {
    const id = reader.i64();
    const type = reader.i16();
    const version = reader.i64();
    const isLazy = reader.bool();
    const hashMethod = reader.i16();
    const localeCount = reader.u8();
    const locales: string[] = [];
    for (let i = 0; i < localeCount; i += 1) locales.push(reader.ascii());
    const fileCount = reader.i16();
    const files: { name: string; size: number }[] = [];
    for (let i = 0; i < fileCount; i += 1) files.push({ name: reader.ascii(), size: reader.i32() });

    // Дальше — параметры ресурса по его типу (см. loaders/client_resource_loader/resource_types.py).
    // Их надо дочитывать ВСЕ, иначе пакет с несколькими ресурсами разъедется: сервер шлёт html5
    // несколько ресурсов одним SV_LOAD_DEPENDENCIES, и после картинки/анимации шёл мусор (тип 0),
    // из-за чего лобби не грузилось и вход «зависал» («Сервер не ответил на вход»).
    let params: Record<string, string> | null = null;
    if (type === 1) {
      // SWF-библиотека: два вектора строк — ключи и значения манифеста бандла
      const keyCount = reader.readLength();
      const keys: string[] = [];
      for (let i = 0; i < keyCount; i += 1) keys.push(reader.str());
      const valueCount = reader.readLength();
      const values: string[] = [];
      for (let i = 0; i < valueCount; i += 1) values.push(reader.str());
      params = {};
      keys.forEach((key, i) => {
        if (params) params[key] = values[i] ?? '';
      });
    } else if (type === 10) {
      // IMAGE: boolean alpha
      params = { alpha: String(reader.bool()) };
    } else if (type === 11) {
      // MULTIFRAME_IMAGE: float fps, int frame_height, int frame_width, short num_frames
      const fps = reader.f32();
      const frameHeight = reader.i32();
      const frameWidth = reader.i32();
      const numFrames = reader.i16();
      params = {
        fps: String(fps),
        frame_height: String(frameHeight),
        frame_width: String(frameWidth),
        num_frames: String(numFrames),
      };
    }

    this.fire('resource', { id, type, version, isLazy, hashMethod, locales, files, params });
    this.log(
      `ресурс ${id} v${version} тип ${type} is_lazy=${isLazy} файлов ${files.length}` +
        (files.length ? ` (${files.map((file) => `${file.name}:${file.size}`).join(', ')})` : '') +
        (params ? ` params=${JSON.stringify(params)}` : ''),
    );
  }

  // --------------------------------------------------------------- пространства
  private async openSpace(id: number, host: string, port: number): Promise<void> {
    if (this.spaces.has(id)) {
      this.log(`пространство ${id} уже открыто`);
      return;
    }
    const name = spaceNameById(id);
    const space: RemoteSpace = { id, name, transport: null, stream: new PackageStream(), objects: new Map() };
    this.spaces.set(id, space);
    this.log(`открывается пространство ${name} (${host}:${port})`);

    const transport = await this.options.connect(host, port);
    space.transport = transport;
    transport.onData = (data) => {
      this.enqueue(async () => {
        const packets = await space.stream.push(data);
        for (const packet of packets) this.handleSpacePacket(space, packet);
      });
    };
    transport.onClose = () => {
      if (this.closed) return;
      this.log(`пространство ${name} отключилось`);
      this.spaces.delete(id);
      this.fire('space-closed', { id, name });
    };

    // рукопожатие канала пространства: byte 3 + 32-байтный хэш клиента
    const writer = new ByteWriter();
    writer.u8(3);
    writer.bytes(this.hash ?? new Uint8Array(32));
    transport.send(wrapPackage(writer));

    this.fire('space', { id, name });
  }

  private handleSpacePacket(space: RemoteSpace, reader: ByteReader): void {
    const objectId = reader.i64();
    const commandId = reader.i64();

    if (objectId === space.id) {
      if (commandId === DISPATCHER_COMMAND.LOAD_OBJECTS) {
        this.loadObjects(space, reader);
        return;
      }
      if (commandId === DISPATCHER_COMMAND.UNLOAD_OBJECTS) {
        const count = reader.readLength();
        const ids: number[] = [];
        for (let index = 0; index < count; index += 1) {
          const id = reader.i64();
          ids.push(id);
          space.objects.delete(id);
        }
        this.fire('unloaded', { spaceId: space.id, spaceName: space.name, ids });
        return;
      }
    }

    if (objectId === this.loginObjectId && commandId === WRONG_PASSWORD_COMMAND_ID) {
      this.log('сервер: неверный логин или пароль');
      this.fire('login-failed', { username: this.username ?? '' });
      return;
    }

    if (commandId === CHAT_COMMAND.MESSAGE) {
      this.fire('chat', { author: reader.str(), rank: reader.i32(), kind: reader.i8(), text: reader.str() });
      return;
    }
    if (commandId === CHAT_COMMAND.ADMIN_STATE) {
      this.isAdmin = reader.i8() === 1;
      this.fire('admin', this.isAdmin);
      return;
    }

    const raw = this.rawHandlers.get(commandId);
    if (raw) {
      try {
        raw(space.name, objectId, reader);
      } catch (error) {
        this.log(`своя команда ${commandId} не разобралась: ${String(error)}`);
      }
      return;
    }

    const bytes = reader.remaining;
    const entry = this.commandEntry(commandId, space.objects.get(objectId), space.name);
    let args: unknown = null;
    let name: string | null = null;
    if (entry) {
      try {
        args = decodeValue(reader, entry.ops);
        name = entry.name;
        if (reader.remaining !== 0) this.log(`команда ${entry.modelClass}.${name}: лишние ${reader.remaining} байт`);
      } catch (error) {
        this.log(`команда ${entry.modelClass}.${entry.name} (${commandId}) не разобралась: ${String(error)}`);
        args = null;
      }
    }
    this.fire('command', {
      spaceId: space.id,
      spaceName: space.name,
      objectId,
      commandId,
      bytes,
      model: entry?.model ?? null,
      name,
      args,
    });
    if (entry?.model === MODEL_ID.USER_PROPERTY && args) this.applyUserPropertyCommand(space, objectId, name, args as Record<string, number>);
  }

  /** покупка в гараже: сервер баланс не присылает — вычитаем сами, как moneyService.spend */
  spendCrystals(price: number): void {
    const space = this.getSpace('lobby');
    const object = this.findObjectWithModel(space, MODEL_ID.USER_PROPERTY);
    const data = object?.models.get(MODEL_ID.USER_PROPERTY) as Record<string, unknown> | undefined;
    if (!space || !data) return;
    data.crystals = Number(data.crystals ?? 0) - price;
    const user = this.readUserInfo(space);
    if (user) this.fire('user', user);
  }

  /** UserPropertyModel: кристаллы, опыт и звание меняются сразу (ящик, золото, награда за бой, убийство) */
  private applyUserPropertyCommand(space: RemoteSpace, objectId: number, name: string | null, args: Record<string, number>): void {
    const data = space.objects.get(objectId)?.models.get(MODEL_ID.USER_PROPERTY) as Record<string, unknown> | undefined;
    if (!data) return;
    if (name === 'CHANGE_CRYSTAL') data.crystals = Number(data.crystals ?? 0) + Number(args.crystals ?? 0);
    else if (name === 'UPDATE_SCORE') data.score = Number(args.score ?? data.score);
    else if (name === 'UPDATE_RANK') {
      data.rank = Number(args.new_rank ?? data.rank);
      data.score = Number(args.score ?? data.score);
      data.next_rank_score = Number(args.next_rank_score ?? data.next_rank_score);
    } else return;
    const user = this.readUserInfo(space);
    if (user) this.fire('user', user);
  }

  /** Вариант команды: тот, чья модель есть у объекта, иначе — того же типа пространства. */
  private commandEntry(commandId: number, object: RemoteObject | undefined, spaceName: string): CommandEntry | undefined {
    const entries = SCHEMA.commands[String(commandId)];
    if (!entries || entries.length === 0) return undefined;
    if (entries.length === 1) return entries[0];
    const byModel = object ? entries.find((entry) => object.modelIds.includes(entry.model)) : undefined;
    const kind = spaceKind(spaceName);
    return byModel ?? entries.find((entry) => entry.space === kind) ?? entries[0];
  }

  private loadObjects(space: RemoteSpace, reader: ByteReader): void {
    const count = reader.readLength();
    const added: RemoteObject[] = [];

    for (let index = 0; index < count; index += 1) {
      const modelCount = reader.readLength();
      const models = new Map<number, unknown>();
      for (let modelIndex = 0; modelIndex < modelCount; modelIndex += 1) {
        const modelId = reader.i64();
        const entry = this.modelEntry(modelId, space.name);
        if (!entry) throw new Error(`нет схемы для модели ${modelId} (${space.name})`);
        models.set(modelId, decodeValue(reader, entry.ops));
      }
      const id = reader.i64();
      const classId = reader.i64();
      const modelIds = this.classes.get(classId) ?? [];
      // повторная загрузка того же объекта добавляет модели (гараж: надетому предмету досылается Item3DModel
      // отдельным классом), прежние данные не теряются
      const previous = space.objects.get(id);
      if (previous) {
        for (const [modelId, data] of previous.models) if (!models.has(modelId)) models.set(modelId, data);
      }
      const mergedIds = previous ? [...new Set([...previous.modelIds, ...modelIds])] : modelIds;
      const object: RemoteObject = { id, classId: previous?.classId ?? classId, modelIds: mergedIds, models, loadedAt: performance.now() };
      space.objects.set(id, object);
      added.push(object);
    }

    this.fire('objects', { spaceId: space.id, spaceName: space.name, added });
    this.log(`пространство ${space.name}: объектов ${space.objects.size} (новых ${added.length})`);

    const user = this.readUserInfo(space);
    if (user) {
      this.fire('user', user);
      if (space.name === 'lobby') this.fire('login-ok', { username: user.uid });
    }
  }

  private modelEntry(modelId: number, spaceName: string): ModelDataEntry | undefined {
    const key = String(modelId);
    const entries = SCHEMA.modelDataDuplicates[key];
    if (entries) {
      const kind = spaceKind(spaceName);
      return entries.find((entry) => entry.space === kind) ?? entries[0] ?? SCHEMA.modelData[key];
    }
    return SCHEMA.modelData[key];
  }

  private readUserInfo(space: RemoteSpace): UserInfo | null {
    const object = this.findObjectWithModel(space, MODEL_ID.USER_PROPERTY);
    if (!object) return null;
    const data = object.models.get(MODEL_ID.USER_PROPERTY) as Partial<UserInfo> & Record<string, unknown>;
    if (!data) return null;
    return {
      uid: String(data.uid ?? ''),
      userId: Number(data.user_id ?? 0),
      crystals: Number(data.crystals ?? 0),
      rank: Number(data.rank ?? 0),
      score: Number(data.score ?? 0),
      nextRankScore: Number(data.next_rank_score ?? 0),
    };
  }

  findObjectWithModel(space: RemoteSpace | undefined, modelId: number): RemoteObject | undefined {
    if (!space) return undefined;
    for (const object of space.objects.values()) {
      if (object.modelIds.includes(modelId)) return object;
    }
    return undefined;
  }

  getSpace(name: string): RemoteSpace | undefined {
    for (const space of this.spaces.values()) if (space.name === name) return space;
    return undefined;
  }

  getSpaceNames(): string[] {
    return [...this.spaces.values()].map((space) => space.name);
  }

  /** запросить ADMIN_STATE заново (ответ после входа мог прийти раньше, чем клиент открыл лобби) */
  requestAdminState(): void {
    const space = this.getSpace('lobby');
    if (space?.transport) this.sendCommand('lobby', space.id, CHAT_COMMAND.ADMIN_STATE);
  }

  /** сообщение или команда («/kick ник») в чат: из боя — в его пространство, иначе в лобби (сервер ответит, что чат в бою) */
  sendChat(text: string): void {
    const names = this.getSpaceNames();
    const name = names.find((spaceName) => spaceName.startsWith('battle_field')) ?? (names.includes('lobby') ? 'lobby' : null);
    const space = name ? this.getSpace(name) : undefined;
    if (!name || !space) return;
    this.sendCommand(name, space.id, CHAT_COMMAND.SEND, (writer) => writer.str(text));
  }

  /** Команда модели серверу: канал пространства, long id объекта, long id команды, параметры. */
  sendCommand(spaceName: string, objectId: number, commandId: number, writeArgs?: (writer: ByteWriter) => void): void {
    const space = this.getSpace(spaceName);
    if (!space?.transport) throw new Error(`пространство ${spaceName} не подключено`);
    const writer = new ByteWriter();
    writer.i64(objectId);
    writer.i64(commandId);
    writeArgs?.(writer);
    space.transport.send(wrapPackage(writer));
  }

  /** Ждёт, пока в пространстве появится объект с моделью (после LoadObjects). */
  async waitForModelObject(spaceName: string, modelId: number, timeoutMs = 15000): Promise<RemoteObject> {
    const started = Date.now();
    for (;;) {
      const object = this.findObjectWithModel(this.getSpace(spaceName), modelId);
      if (object) return object;
      if (Date.now() - started > timeoutMs) throw new Error(`в ${spaceName} не появился объект с моделью ${modelId}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // -------------------------------------------------------------------- логин
  private loginObjectId: number | null = null;
  private username: string | null = null;

  async login(username: string, password: string, rememberMe = false): Promise<void> {
    this.username = username;
    const space = await this.waitForSpace('entrance', 30000);
    if (!space.transport) throw new Error('пространство entrance не подключено');

    const object = await this.waitForObject(space, MODEL_ID.LOGIN, 90000);
    this.loginObjectId = object.id;

    const writer = new ByteWriter();
    writer.i64(object.id);
    writer.i64(LOGIN_COMMAND_ID);
    writer.str(username);
    writer.str(password);
    writer.bool(rememberMe);
    space.transport.send(wrapPackage(writer));
    this.log(`логин отправлен: ${username}`);
  }

  /**
   * Регистрация (registration_model_command_handler.register). Сервер после неё сам
   * логинит пользователя; при занятом имени или неверном формате молча ничего не делает.
   */
  async register(username: string, password: string, rememberMe = false): Promise<void> {
    this.username = username;
    const space = await this.waitForSpace('entrance', 30000);
    if (!space.transport) throw new Error('пространство entrance не подключено');

    const object = await this.waitForObject(space, MODEL_ID.REGISTRATION, 90000);
    this.loginObjectId = this.findObjectWithModel(space, MODEL_ID.LOGIN)?.id ?? null;

    const writer = new ByteWriter();
    writer.i64(object.id);
    writer.i64(REGISTER_COMMAND_ID);
    writer.str(username);
    writer.str(password);
    writer.str(''); // registered_url_code
    writer.bool(rememberMe);
    writer.writeOptionalBit(1); // referral_hash_code отсутствует
    writer.str(''); // real_name
    writer.str(''); // id_number
    space.transport.send(wrapPackage(writer));
    this.log(`регистрация отправлена: ${username}`);
  }

  private async waitForSpace(name: string, timeoutMs: number): Promise<RemoteSpace> {
    const started = Date.now();
    for (;;) {
      const space = this.getSpace(name);
      if (space?.transport) return space;
      if (Date.now() - started > timeoutMs) throw new Error(`пространство ${name} не открылось за ${timeoutMs} мс`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async waitForObject(space: RemoteSpace, modelId: number, timeoutMs: number): Promise<RemoteObject> {
    const started = Date.now();
    for (;;) {
      const object = this.findObjectWithModel(space, modelId);
      if (object) return object;
      if (Date.now() - started > timeoutMs) throw new Error(`объект с моделью ${modelId} не пришёл за ${timeoutMs} мс`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Для отладки: все объекты пространства с разобранными моделями. */
  dumpSpace(name: string): string {
    const space = this.getSpace(name);
    if (!space) return `пространства ${name} нет`;
    const lines = [`[${name}] объектов: ${space.objects.size}`];
    for (const object of space.objects.values()) {
      const models = [...object.models.entries()].map(([id, data]) => `${id}=${JSON.stringify(data)}`);
      lines.push(`  object ${object.id} (class ${object.classId}, models [${object.modelIds.join(',')}])`);
      for (const model of models) lines.push(`    ${model}`);
    }
    return lines.join('\n');
  }
}
