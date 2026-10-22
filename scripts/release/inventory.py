"""Read-only inventories from exact installed artifacts; no scanner/tool install.

Retains npm/JAR/OS notices without running application or browser code. Image
containers are temporary, network-disabled and removed even after failure.
This is an inventory, not legal approval or a vulnerability certification.
"""
import base64
import concurrent.futures
import datetime
import functools
import hashlib
import io
import json
import pathlib
import re
import sqlite3
import struct
import subprocess
import tarfile
import tempfile
import urllib.parse
import urllib.request
import uuid
import zipfile
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/implementation/artifacts/release-closure'
IMAGES = {'api': 'options-trade-ideas-api:p14-local', 'worker': 'options-trade-ideas-worker:p14-local', 'identity': 'options-trade-ideas-identity:p14-local'}


def run(args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180, **kwargs).stdout


def safe(value):
    return re.sub(r'[^A-Za-z0-9._-]', '_', value)


def add_notice(archive, index, path, data):
    if len(data) > 16 * 1024 * 1024:
        raise ValueError('Notice exceeds bounded retention size')
    digest = hashlib.sha256(data).hexdigest()
    name = '/'.join(safe(part) for part in path.split('/') if part not in ['', '.', '..'])
    info = tarfile.TarInfo(name)
    info.size, info.mtime, info.mode = len(data), 0, 0o644
    archive.addfile(info, io.BytesIO(data))
    index.append({'path': name, 'sha256': digest, 'bytes': len(data)})


def npm_notices(packages, archive, index):
    for package in packages:
        for notice in package.pop('notices', []):
            add_notice(archive, index, f"npm/{package['name']}@{package['version']}/{notice['name']}", base64.b64decode(notice['base64'], validate=True))


def registry_label(ref):
    name, version = ref['name'], ref['version']
    url = 'https://registry.npmjs.org/' + urllib.parse.quote(name, safe='') + '/' + urllib.parse.quote(version, safe='')
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'communitrade-release-inventory'}), timeout=20) as response:
            raw = response.read(5 * 1024 * 1024 + 1)
        if len(raw) > 5 * 1024 * 1024:
            raise ValueError('metadata too large')
        data = json.loads(raw)
        if (data.get('name'), data.get('version')) != (name, version):
            raise ValueError('identity mismatch')
        value = data.get('license', data.get('licenses'))
        def label(item):
            if isinstance(item, str):
                return item
            if isinstance(item, list):
                return ' OR '.join(filter(None, map(label, item)))
            return item.get('type') if isinstance(item, dict) else None
        return {**ref, 'license': label(value), 'evidence': 'exact-version registry metadata; not installed on this platform', 'metadataUrl': url, 'metadataSha256': hashlib.sha256(raw).hexdigest()}
    except Exception as error:
        return {**ref, 'license': None, 'evidence': 'registry metadata unavailable', 'metadataUrl': url, 'errorType': type(error).__name__}


def host_inventory():
    packages = json.loads(run(['node', 'scripts/release/npm-inventory.mjs']))
    listed = json.loads(run(['pnpm', 'list', '--recursive', '--prod', '--depth', 'Infinity', '--json']))
    wanted = {}
    workspace = set()
    def visit(item):
        for key in ['dependencies', 'optionalDependencies']:
            for name, dependency in item.get(key, {}).items():
                version = dependency.get('version', '')
                if name.startswith('@trading/') or version.startswith('link:'):
                    workspace.add(name)
                elif re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][\w.-]+)?', version):
                    wanted[(name, version)] = {'name': name, 'version': version}
                else:
                    raise ValueError('Unexpected dependency identity')
                visit(dependency)
    for item in listed:
        visit(item)
    installed = {(p['name'], p['version']): p for p in packages}
    resolved, missing = [], []
    notice_index = []
    with tarfile.open(OUT / 'host-npm-notices.tar.gz', 'w:gz') as archive:
        for identity, ref in wanted.items():
            if identity in installed:
                package = installed[identity]
                npm_notices([package], archive, notice_index)
                resolved.append({**package, 'evidence': 'installed artifact'})
            else:
                missing.append(ref)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        resolved.extend(pool.map(registry_label, missing))
    return {'scope': 'workspace production dependency closure including optional platform variants; no packages installed', 'workspacePackages': sorted(workspace), 'packages': sorted(resolved, key=lambda p: (p['name'], p['version'])), 'noticeFiles': notice_index, 'unresolvedLicenseMetadata': [p['name']+'@'+p['version'] for p in resolved if not p['license']]}


def rpm_packages(path):
    # RPM immutable header tag values: NAME=1000 VERSION=1001 RELEASE=1002
    # LICENSE=1014 ARCH=1022. Bounds checked; read-only copied sqlite database.
    result = []
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        for (blob,) in db.execute('SELECT blob FROM Packages'):
            # rpmdb exports omit the 8-byte magic/reserved prefix used in .rpm files.
            index_at = 16 if blob.startswith(b'\x8e\xad\xe8\x01\0\0\0\0') else 8
            count, size = struct.unpack_from('>II', blob, index_at-8)
            if count > 20000 or index_at+count*16+size > len(blob):
                raise ValueError('Malformed RPM header bounds')
            data_at, tags = index_at+count*16, {}
            for n in range(count):
                tag, kind, offset, _ = struct.unpack_from('>IIII', blob, index_at+n*16)
                if tag in [1000, 1001, 1002, 1014, 1022] and kind == 6:
                    if offset >= size:
                        raise ValueError('Malformed RPM string offset')
                    tags[tag] = blob[data_at+offset:data_at+size].split(b'\0', 1)[0].decode('utf8')
            if not all(k in tags for k in [1000, 1001, 1002, 1022]):
                raise ValueError('RPM identity incomplete')
            result.append({'name': tags[1000], 'version': tags[1001]+'-'+tags[1002], 'architecture': tags[1022], 'license': tags.get(1014)})
    return result



@functools.lru_cache(maxsize=2048)
def maven_license(group, artifact, version, depth=0):
    if depth > 4 or not all(re.fullmatch(r'[A-Za-z0-9_.-]+', x) for x in [group, artifact, version]):
        return {'status': 'unresolved coordinates'}
    url = 'https://repo.maven.apache.org/maven2/' + group.replace('.', '/') + '/' + artifact + '/' + version + '/' + artifact + '-' + version + '.pom'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'communitrade-release-inventory'}), timeout=15) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('POM too large')
        root = ET.fromstring(raw)
        licenses = [{'name': node.findtext('{*}name'), 'url': node.findtext('{*}url')} for node in root.findall('{*}licenses/{*}license')]
        result = {'metadataUrl': url, 'sha256': hashlib.sha256(raw).hexdigest(), 'licenses': licenses}
        if not licenses:
            parent = root.find('{*}parent')
            if parent is not None:
                result['parent'] = maven_license(parent.findtext('{*}groupId') or '', parent.findtext('{*}artifactId') or '', parent.findtext('{*}version') or '', depth+1)
        return result
    except Exception as error:
        return {'metadataUrl': url, 'status': 'unavailable', 'errorType': type(error).__name__}


def resolve_jar(jar):
    evidence = []
    for text in jar['maven']:
        fields = dict(line.split('=', 1) for line in text.splitlines() if '=' in line and not line.startswith('#'))
        if all(fields.get(k) for k in ['groupId', 'artifactId', 'version']):
            evidence.append(maven_license(fields['groupId'], fields['artifactId'], fields['version']))
    def declared(row):
        return bool(row.get('licenses')) or bool(row.get('parent') and declared(row['parent']))
    if not any(declared(row) for row in evidence):
        match = re.fullmatch(r'(.+)-(\d+\..+)\.jar', jar['filename'])
        if match:
            name, version = match.groups()
            for cut in reversed([i for i, char in enumerate(name) if char == '.']):
                result = maven_license(name[:cut], name[cut+1:], version)
                if result.get('status') not in ['unavailable', 'unresolved coordinates']:
                    evidence.append({**result, 'coordinateSource': 'Quarkus distribution filename candidate; review upstream identity before approval'})
                    break
    jar['publishedLicenseMetadata'] = evidence
    return jar


def image_inventory(label, image):
    inspect = json.loads(run(['docker', 'image', 'inspect', image]))[0]
    identity = {k: inspect[k] for k in ['Id', 'Architecture', 'Os']}
    notice_index, jars, os_packages, packages, gaps = [], [], [], [], []
    container = run(['docker', 'create', '--network', 'none', '--read-only', '--name', 'communitrade-inventory-'+uuid.uuid4().hex[:16], '--entrypoint', 'sh', image]).decode().strip()
    try:
        with tarfile.open(OUT / (label+'-notices.tar.gz'), 'w:gz') as archive:
            if label in ['api', 'worker']:
                source = (ROOT / 'scripts/release/npm-inventory.mjs').read_text()
                # Import helpers via a data URL; inventory code never touches app source/env.
                source = source[:source.index('if(process.argv[1]')]
                url = 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()
                code = f"const m=await import({json.dumps(url)});console.log(JSON.stringify(await m.installedInventory('/app/node_modules')));"
                packages = json.loads(run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', image, '--input-type=module', '-e', code]))
                npm_notices(packages, archive, notice_index)
            paths = ['/usr/share/doc', '/usr/share/licenses', '/usr/local/LICENSE']
            if label != 'identity':
                paths += ['/var/lib/dpkg/status']
            if label == 'identity':
                paths += ['/opt/keycloak/LICENSE.txt', '/opt/keycloak/lib/lib/main', '/var/lib/rpm/rpmdb.sqlite']
            if label == 'worker':
                browser_files = run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'sh', image, '-c', "find /ms-playwright -type f \\( -iname '*license*' -o -iname '*notice*' -o -iname '*copying*' \\)"]).decode().splitlines()
                paths += browser_files
            for path in paths:
                copied = subprocess.run(['docker', 'cp', container+':'+path, '-'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
                if copied.returncode:
                    if path in ['/usr/share/doc', '/usr/share/licenses', '/usr/local/LICENSE']:
                        continue  # Different base distributions place notices differently.
                    gaps.append({'path': path, 'reason': 'not present or not readable'})
                    continue
                with tarfile.open(fileobj=io.BytesIO(copied.stdout)) as members:
                    for member in members:
                        if not member.isfile():
                            continue
                        body = members.extractfile(member).read()
                        if path.endswith('/status'):
                            for stanza in body.decode().split('\n\n'):
                                fields = dict(line.split(': ', 1) for line in stanza.splitlines() if ': ' in line and not line.startswith(' '))
                                if fields.get('Status') == 'install ok installed':
                                    os_packages.append({k: fields.get(k) for k in ['Package', 'Version', 'Architecture', 'Source']})
                        elif path.endswith('rpmdb.sqlite'):
                            with tempfile.TemporaryDirectory() as tmp:
                                db = pathlib.Path(tmp)/'rpm.sqlite';db.write_bytes(body);os_packages += rpm_packages(db)
                        elif member.name.endswith('.jar'):
                            with zipfile.ZipFile(io.BytesIO(body)) as jar:
                                manifest = jar.read('META-INF/MANIFEST.MF').decode(errors='replace') if 'META-INF/MANIFEST.MF' in jar.namelist() else ''
                                fields = dict(line.split(': ', 1) for line in manifest.splitlines() if ': ' in line and not line.startswith(' '))
                                record = {'filename': pathlib.PurePosixPath(member.name).name, 'sha256': hashlib.sha256(body).hexdigest(), 'implementationTitle': fields.get('Implementation-Title'), 'implementationVersion': fields.get('Implementation-Version'), 'maven': [], 'notices': 0}
                                for filename in jar.namelist():
                                    if filename.endswith('pom.properties'):
                                        record['maven'].append(jar.read(filename).decode(errors='replace').strip())
                                    if filename.startswith('META-INF/') and re.search(r'(LICENSE|NOTICE|COPYING|COPYRIGHT)', filename, re.I) and not filename.endswith('/'):
                                        add_notice(archive, notice_index, 'jars/'+record['filename']+'/'+filename, jar.read(filename));record['notices'] += 1
                                jars.append(record)
                        elif path.startswith('/usr/share/licenses') or path.startswith('/ms-playwright') or re.search(r'(copyright|licen[cs]e|notice|copying)', member.name, re.I):
                            add_notice(archive, notice_index, 'image'+path+'/'+member.name, body)
        if jars:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                jars = list(pool.map(resolve_jar, jars))
        return {'image': image, **identity, 'npmPackages': packages, 'osPackages': os_packages, 'jars': jars, 'noticeFiles': notice_index, 'unresolvedNpmLicenses': [p['name']+'@'+p['version'] for p in packages if not p['workspace'] and not p['license']], 'jarsWithoutEmbeddedNotices': [j['filename'] for j in jars if not j['notices']], 'collectionGaps': gaps, 'scope': 'actual local final image; architecture-specific; image inventory and retained available notices, not legal review or vulnerability scan'}
    finally:
        run(['docker', 'rm', container])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    record = {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'legalApproval': False, 'host': host_inventory(), 'images': {}}
    for label, image in IMAGES.items():
        record['images'][label] = image_inventory(label, image)
        (OUT / 'inventory.json').write_text(json.dumps(record, indent=2)+'\n')
        print(label, 'inventory collected', flush=True)
    record['archives'] = [{'file': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'bytes': p.stat().st_size} for p in sorted(OUT.glob('*-notices.tar.gz'))]
    (OUT / 'inventory.json').write_text(json.dumps(record, indent=2)+'\n')
    print('Inventory saved; review gaps before G11 closure. No application/browser launched or artifact uploaded.')


if __name__ == '__main__':
    main()
