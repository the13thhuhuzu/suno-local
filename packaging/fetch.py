"""Fetch pinned build inputs into the local cache, then verify every SHA-256."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from subprocess import run
import hashlib
import json
import re
import tempfile

cache = Path(__file__).resolve().parent / 'cache'
cache.mkdir(exist_ok=True)
node_root = 'https://nodejs.org/dist/v24.22.1/'
node_mac = 'node-v24.22.1-darwin-arm64.tar.gz'
node_win = 'node-v24.22.1-win-x64.7z'
node_assets = {
    node_mac: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
    node_win: 'bf9245db3a3bb281da45fee3974a74403687ea6030587bee4fd992efc822c35c',
}
mac_source = 'ffmpeg-9.0.2.tar.xz'
mac_source_sha = '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'
lame_source = 'lame-3.100.tar.gz'
lame_source_sha = 'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e'

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def curl(url, *args):
    result = run(['curl', '-fsSL', '--http1.1', '--connect-timeout', '20', '--max-time', '160',
                  '--retry', '2', '--retry-all-errors', *args, url], capture_output=True)
    if result.returncode:
        raise RuntimeError(f'curl exited with status {result.returncode}')
    return result

def acquire(name, url, sha, size=None, auth=None):
    target = cache / name
    if target.exists() and digest(target) == sha:
        print(f'{name}: verified', flush=True)
        return
    with tempfile.TemporaryDirectory(dir=cache) as tmp:
        temp = Path(tmp)
        out = temp / 'asset'
        if size is None and auth is None:
            headers = curl(url, '-r', '0-0', '-D', '-', '-o', '/dev/null').stdout
            match = re.search(rb'(?im)^content-range: bytes 0-0/(\d+)', headers)
            size = int(match[1]) if match else None
        if size and size > 8 * 1024 * 1024:
            def get_part(index):
                begin, end = index * size // 8, (index + 1) * size // 8 - 1
                part = temp / str(index)
                ranged_url = url + ('&' if '?' in url else '?') + f'suno_range={begin}'
                head = curl(ranged_url, '-r', f'{begin}-{end}', '-D', '-', '-o', str(part)).stdout.lower()
                if f'content-range: bytes {begin}-{end}/{size}'.encode() not in head or part.stat().st_size != end-begin+1:
                    raise ValueError(f'Invalid byte range for {name}')
                return part
            with ThreadPoolExecutor(max_workers=8) as pool:
                with out.open('wb') as stream:
                    for part in pool.map(get_part, range(8)):
                        stream.write(part.read_bytes())
        else:
            headers = ['-H', 'Authorization: Bearer ' + auth] if auth else []
            curl(url, *headers, '-o', str(out))
        if digest(out) != sha:
            raise ValueError(f'SHA-256 mismatch for {name}')
        out.replace(target)
    print(f'{name}: verified', flush=True)

def nsis():
    sha = 'e7c507dc02c50a630db44948fc68ff4dea7c2bae64592d96d134952c2624ddc1'
    target = cache / 'makensis-3.13-arm64-tahoe.tar.gz'
    if target.exists() and digest(target) == sha:
        print(f'{target.name}: verified', flush=True)
        return
    token_url = 'https://ghcr.io/token?service=ghcr.io&scope=repository:homebrew/core/makensis:pull'
    token = json.loads(curl(token_url).stdout)['token']
    acquire(target.name, f'https://ghcr.io/v2/homebrew/core/makensis/blobs/sha256:{sha}', sha, auth=token)

if __name__ == '__main__':
    with ThreadPoolExecutor(max_workers=3) as pool:
        requests = [pool.submit(acquire, name,
                    ('https://nodejs.org/download/release/v24.22.1/' if name == node_win else node_root) + name, sha)
                    for name, sha in node_assets.items()]
        requests.append(pool.submit(acquire, mac_source, 'https://ffmpeg.org/releases/' + mac_source, mac_source_sha))
        requests.append(pool.submit(acquire, lame_source,
            'https://downloads.sourceforge.net/project/lame/lame/3.100/' + lame_source, lame_source_sha))
        requests.append(pool.submit(nsis))
        errors = []
        for request in requests:
            try:
                request.result()
            except (ValueError, RuntimeError) as error:
                errors.append(str(error))
        if errors:
            raise SystemExit('\n'.join(errors))
