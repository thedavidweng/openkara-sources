#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Build the reproducible NetEase QuickJS source archive.

Layout (package/ prefix inside the tar):
  package/manifest.json  package/dist/entry.mjs  package/src/*.mjs
  package/LICENSE  package/NOTICE  package/SOURCES.md
  package/package.json  package/package-lock.json  package/README.md
  package/tools/*  package/test/weapi-vector.mjs  package/LICENSES/*

Determinism: fixed member order, uid/gid 0, modes (0o644 files, 0o755 dirs),
mtime 0, gzip mtime 0, sort check on inputs. Only the standard library.
"""
import argparse
import base64
import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    "manifest.json",
    "dist/entry.mjs",
    "src/main.mjs",
    "src/upstream.mjs",
    "src/crypto.mjs",
    "LICENSE",
    "NOTICE",
    "SOURCES.md",
    "package.json",
    "package-lock.json",
    "README.md",
    "tools/bundle.mjs",
    "tools/pack.py",
    "test/weapi-vector.mjs",
    "LICENSES/netease-api-MIT.txt",
]


def build_members():
    members = []
    for name in FILES:
        data = (ROOT / name).read_bytes()
        members.append((f"package/{name}", data))
    return members


def write_tar(members):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for arcname, data in members:
            info = tarfile.TarInfo(arcname)
            info.size = len(data)
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mode = 0o644
            info.mtime = 0
            info.pax_headers = {}
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="dist")
    args = parser.parse_args()
    outdir = (ROOT / args.out).resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / "manifest.json").read_text())
    version = manifest["version"]

    # Clean slate: only our own dist outputs.
    for old in sorted(outdir.glob(f"openkara-source-netease-{version}.tar.gz*")):
        old.unlink()

    bundle = ROOT / "dist" / "entry.mjs"
    if not bundle.is_file():
        raise SystemExit("dist/entry.mjs is missing; run: npm ci && npm run bundle")
    if manifest["entry"] != "dist/entry.mjs":
        raise SystemExit("manifest entry must be dist/entry.mjs")

    tar_bytes = write_tar(build_members())
    gz = gzip.compress(tar_bytes, compresslevel=9, mtime=0)
    archive = outdir / f"openkara-source-netease-{version}.tar.gz"
    archive.write_bytes(gz)

    sha256 = hashlib.sha256(gz).hexdigest()
    sha512 = hashlib.sha512(gz).digest()
    entry_digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    file_list = [f"package/{n}" for n in FILES]
    meta = {
        "source_id": manifest["source_id"],
        "package_id": manifest["package_id"],
        "version": manifest["version"],
        "entry": manifest["entry"],
        "entry_sha256": entry_digest,
        "entry_bytes": bundle.stat().st_size,
        "file": archive.name,
        "format": "tar.gz",
        "size": len(gz),
        "sha256": sha256,
        "sha512_sri": "sha512-" + base64.b64encode(sha512).decode(),
        "files": file_list,
    }
    (outdir / f"{archive.name}.meta.json").write_text(json.dumps(meta, indent=2) + "\n")

    # Second independent build from a clean output dir; bytes must match.
    import tempfile
    with tempfile.TemporaryDirectory(prefix="openkara-pack-verify-") as tmp:
        verify = Path(tmp) / "verify.tar.gz"
        verify.write_bytes(gzip.compress(write_tar(build_members()), compresslevel=9, mtime=0))
        if verify.read_bytes() != gz:
            raise SystemExit("reproducibility check failed: second build differs")
    print(json.dumps({k: meta[k] for k in ("file", "size", "sha256", "entry_sha256")}, indent=2))


if __name__ == "__main__":
    main()
