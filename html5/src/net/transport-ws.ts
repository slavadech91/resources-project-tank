/** Транспорт через WebSocket-мост (server/bridge.mjs): браузер не умеет сырой TCP. */

import type { ConnectFn, Transport } from './client.ts';

const BRIDGE_STORAGE_KEY = 'tanki.bridge';

/** открыто с этого же компьютера (Vite или локальная сборка) */
export function isLocalPage(): boolean {
  const host = window.location.hostname;
  return !host || host == '127.0.0.1' || host == 'localhost';
}

/** «https://abc.lhr.life» или «wss://abc.lhr.life/bridge» -> «wss://abc.lhr.life/bridge» */
export function normalizeBridgeUrl(text: string): string {
  let value = text.trim();
  if (!value) return '';
  if (!/^[a-z]+:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  url.protocol = url.protocol == 'http:' || url.protocol == 'ws:' ? 'ws:' : 'wss:';
  if (url.pathname == '/' || url.pathname == '') url.pathname = '/bridge';
  url.search = '';
  return url.toString();
}

export function getSavedBridge(): string {
  try {
    return window.localStorage.getItem(BRIDGE_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveBridge(text: string): void {
  try {
    window.localStorage.setItem(BRIDGE_STORAGE_KEY, normalizeBridgeUrl(text));
  } catch {
    /* хранилище недоступно — адрес придётся вводить заново */
  }
}

/**
 * Адрес моста: ?bridge=..., иначе (страница на удалённом хостинге) сохранённый адрес туннеля, иначе тот же адрес,
 * по которому открыта страница (её раздаёт server/public-server.mjs с прокси /bridge).
 */
export function bridgeUrlFromLocation(): string {
  const override = new URLSearchParams(window.location.search).get('bridge');
  if (override) return normalizeBridgeUrl(override);
  if (isLocalPage()) return `ws://${window.location.hostname || '127.0.0.1'}:5181/`;
  const saved = getSavedBridge();
  if (saved) return saved;
  return `${window.location.protocol == 'https:' ? 'wss' : 'ws'}://${window.location.host}/bridge`;
}

export function createBridgeConnect(bridgeUrl: string): ConnectFn {
  return (host: string, port: number) =>
    new Promise<Transport>((resolve, reject) => {
      const url = `${bridgeUrl}?host=${encodeURIComponent(host)}&port=${port}`;
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';

      const transport: Transport = {
        onData: null,
        onClose: null,
        send(data: Uint8Array): void {
          if (socket.readyState === WebSocket.OPEN) socket.send(data);
        },
        close(): void {
          socket.close();
        },
      };

      socket.onopen = () => resolve(transport);
      socket.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) transport.onData?.(new Uint8Array(event.data));
      };
      socket.onclose = () => transport.onClose?.();
      socket.onerror = () => {
        reject(new Error(`мост недоступен: ${url} (запущен ли node html5/server/bridge.mjs?)`));
      };
    });
}
