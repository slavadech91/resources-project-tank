"""Prepare a private Overhaul runtime archive from a working project checkout."""
import argparse
import io
import json
import tarfile
import xml.etree.ElementTree as ET
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--published-config', type=Path,
                        help='use a known deployed copy of dev/configs (excludes unshipped maps)')
    parser.add_argument('--exclude-map', action='append', default=[], help='omit a map by its client key')
    args = parser.parse_args()
    source = args.source.resolve()
    config = args.published_config.resolve() if args.published_config else source / 'dev/configs'
    map_config = json.loads((config / 'maps.json').read_text(encoding='utf-8'))
    maps = [item for item in map_config['maps']
            if item['map_resource'].rstrip('/').rsplit('/', 1)[-1] not in args.exclude_map]
    map_config['maps'] = maps
    keys = {item['map_resource'].rstrip('/').rsplit('/', 1)[-1] for item in maps}
    map_files = {item['map_xml'] for item in maps}
    public = source / 'html5/public'
    libraries = set()
    for key in keys:
        refs = ET.parse(public / 'maps' / key / 'proplibs.xml')
        libraries.update(item.attrib['resource-id'].rsplit('/', 1)[-1] for item in refs.findall('library'))
    properties = json.loads((config / 'server_properties.json').read_text(encoding='utf-8'))
    properties = {key: value for key, value in properties.items() if not key.startswith('database_')}
    properties.update(database_addres='127.0.0.1', database_user='overhaul', database_name='overhaul')
    required = [config / 'path_to_id.json']
    required.extend(config / 'maps' / name for name in sorted(map_files))
    for folder in ('garage_items', 'graphics_settings'):
        required.extend(sorted((config / folder).glob('*.json')))
    asset_folders = {'battle', 'bonuses', 'lobby', 'maps', 'proplibs', 'tank_parts', 'themes'}
    with tarfile.open(args.output, 'w:gz', compresslevel=4) as archive:
        for path in required:
            archive.add(path, arcname='dev/configs/' + path.relative_to(config).as_posix(), recursive=False)
        for name, value in [('maps.json', map_config), ('server_properties.json', properties)]:
            raw = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
            info = tarfile.TarInfo('dev/configs/' + name)
            info.size = len(raw)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(raw))
        for path in sorted(public.rglob('*')):
            relative = path.relative_to(public)
            if len(relative.parts) < 2 or relative.parts[0] not in asset_folders:
                continue
            if not path.is_file() or path.is_symlink() or any(part.startswith('.') for part in relative.parts):
                continue
            if path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp3', '.ogg', '.wav', '.woff', '.woff2', '.ttf', '.json', '.xml'}:
                continue
            if relative.parts[0] == 'maps' and relative.parts[1] not in keys:
                continue
            if relative.parts[0] == 'proplibs' and relative.parts[1] not in libraries:
                continue
            archive.add(path, arcname='html5/public/' + relative.as_posix(), recursive=False)


if __name__ == '__main__':
    main()
