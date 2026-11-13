/** Карты из общего конфига `configs/maps.json`. */
import { readFileSync } from 'node:fs';
import {parseFlagBases} from '../battle/mapData.ts';
import { join } from 'node:path';
import type { BattleMode, MapSummary } from '../../../html5/src/net2/protocol.ts';

interface MapConfig {
  map_id: number;
  map_xml?:string;
  name_ru?: string;
  name_en?: string;
  max_people?: number;
  supported_modes?: string[];
  rank_limit_min?: number;
  rank_limit_max?: number;
  theme?: string;
  preview_image?: string;
}

export function loadMaps(configDir: string): MapSummary[] {
  const config = JSON.parse(readFileSync(join(configDir, 'maps.json'), 'utf8')) as { maps: MapConfig[] };
  // путь ресурса → id, как у старого сервера (картинки лобби html5 лежат по id)
  const resourceIds = JSON.parse(readFileSync(join(configDir, 'path_to_id.json'), 'utf8')) as Record<string, number>;
  return config.maps.map((map) => ({
    id: map.map_id,
    name: map.name_ru || map.name_en || `#${map.map_id}`,
    maxPeople: map.max_people ?? 10,
    modes: (map.supported_modes ?? ['dm']).filter((mode): mode is BattleMode => mode === 'dm' || mode === 'tdm' || (mode === 'ctf' && !!parseFlagBases(readFileSync(join(configDir,'maps',map.map_xml??''),'utf8')))),
    minRank: Math.max(1, map.rank_limit_min ?? 1),
    maxRank: Math.min(30, map.rank_limit_max ?? 30),
    theme: map.theme ?? 'summer',
    previewId: resourceIds[map.preview_image ?? ''] ?? 0,
  }));
}
