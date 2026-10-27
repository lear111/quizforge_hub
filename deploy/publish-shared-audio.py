#!/usr/bin/env python3
"""Root-owned SSH-only publisher. No HTTP uploads, overwrite, or arbitrary paths."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys
import tempfile

MAX_BYTES = 64 * 1024 * 1024
ROOT = Path('/var/lib/quizforge-shared-media-test')
ORIGIN = 'https://quizforge-test.treenewbee.cloud'
TYPES = {'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 'm4a': 'audio/mp4'}


def audio_type(header, extension):
    valid = {
        'mp3': header.startswith(b'ID3') or len(header) >= 3 and header[0] == 255 and header[1] & 224 == 224,
        'wav': header.startswith(b'RIFF') and header[8:12] == b'WAVE',
        'ogg': header.startswith(b'OggS'),
        'm4a': header[4:8] == b'ftyp',
    }
    if not valid.get(extension):
        raise ValueError('Unsupported audio header or extension')
    return TYPES[extension]


def real_directory(directory):
    # Reject symlink ancestors as well as a symlink in the final component.
    if directory.resolve() != directory.absolute():
        raise ValueError('Directory must not use symlinks')
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('Expected a real directory')


def publish(stream, root, expected_sha, extension, expected_size):
    if not re.fullmatch(r'[a-f0-9]{64}', expected_sha) or extension not in TYPES:
        raise ValueError('Invalid resource identity')
    if type(expected_size) is not int or not 0 < expected_size <= MAX_BYTES:
        raise ValueError('Audio must be between 1 byte and 64 MiB')
    root = Path(root).absolute()
    for directory in (root, root / 'audio', root / '.incoming'):
        real_directory(directory)
    destination = root / 'audio' / (expected_sha + '.' + extension)
    fd, temporary = tempfile.mkstemp(prefix='audio-', dir=root / '.incoming')
    try:
        digest = hashlib.sha256()
        total, header = 0, b''
        with os.fdopen(fd, 'wb') as output:
            while True:
                block = stream.read(min(1024 * 1024, expected_size - total + 1))
                if not block:
                    break
                total += len(block)
                if total > expected_size:
                    raise ValueError('Audio exceeds declared size')
                if len(header) < 16:
                    header += block[:16 - len(header)]
                digest.update(block)
                output.write(block)
            if total != expected_size or digest.hexdigest() != expected_sha:
                raise ValueError('Audio size or SHA-256 mismatch')
            mime = audio_type(header, extension)
            output.flush()
            os.chmod(temporary, 0o644)
            os.fsync(output.fileno())
        status = 'uploaded'
        try:
            # Same-filesystem hard link publishes the complete file without replacing any existing entry.
            os.link(temporary, destination)
        except FileExistsError:
            info = destination.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size != total:
                raise ValueError('Existing resource is not the expected regular file')
            with destination.open('rb') as existing:
                if hashlib.file_digest(existing, 'sha256').hexdigest() != expected_sha:
                    raise ValueError('Existing resource bytes differ; no replacement made')
            status = 'reused'
        if hasattr(os, 'O_DIRECTORY'):
            directory_fd = os.open(root / 'audio', os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        relative = 'audio/' + destination.name
        return {'status': status, 'sha256': expected_sha, 'bytes': total, 'mime': mime,
                'path': relative, 'url': ORIGIN + '/shared-media/' + relative}
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--extension', choices=TYPES, required=True)
    parser.add_argument('--size', type=int, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or socket.gethostname() != 'VM-0-12-ubuntu':
        raise ValueError('Use only as root on the designated test host')
    result = publish(sys.stdin.buffer, ROOT, args.sha256, args.extension, args.size)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
