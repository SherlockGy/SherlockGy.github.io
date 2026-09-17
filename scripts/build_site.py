"""Build a static Pages artifact with derived cover images; never edit source content."""
import argparse
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import shutil
from urllib.parse import unquote, urlsplit

from PIL import Image, ImageOps, __version__ as pillow_version, features

WIDTHS = (480, 960)
QUALITY = 82
RECIPE = f"cover-v1:webp:q{QUALITY}:pillow{pillow_version}:webp{features.version('webp')}"
MARKER = ".atlas-generated-site"


def local_image(root, src):
    """Resolve repository images only; external images keep their original URL."""
    url = urlsplit(src)
    if url.scheme or url.netloc:
        if url.scheme != "https" or url.netloc != "sherlockgy.github.io":
            return None
    if url.query or url.fragment:
        return None
    path = (root / unquote(url.path).lstrip("/")).resolve()
    if not path.is_relative_to((root / "images").resolve()):
        raise ValueError(f"Cover must be inside images/: {src}")
    if not path.is_file():
        raise ValueError(f"Cover file is missing: {src}")
    return path


def cover_variants(path, cache, output, report):
    source = path.read_bytes()
    digest = sha256(RECIPE.encode() + b"\0" + source).hexdigest()
    variants = []
    decoded = None
    seen_widths = set()
    for width in WIDTHS:
        name = f"{digest}-{width}.webp"
        cached = cache / name
        if cached.exists():
            try:
                with Image.open(cached) as image:
                    dimensions = image.size
                    if image.format != "WEBP" or not (0 < image.width <= width and 0 < image.height <= width * 2):
                        raise ValueError("Invalid cached image")
                    image.verify()
                report["cached"] += 1
            except (OSError, ValueError):
                cached.unlink()
        if not cached.exists():
            if decoded is None:
                with Image.open(BytesIO(source)) as image:
                    # A cover is a still image; reading continues to use the full original.
                    image.seek(0)
                    oriented = ImageOps.exif_transpose(image)
                    decoded = oriented.convert("RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB")
            ratio = min(1, width / decoded.width, width * 2 / decoded.height)
            dimensions = (max(1, round(decoded.width * ratio)), max(1, round(decoded.height * ratio)))
            image = decoded.resize(dimensions, Image.Resampling.LANCZOS)
            image.save(cached, "WEBP", quality=QUALITY, method=4)
            report["generated"] += 1
        # Small originals must not produce duplicate width descriptors in srcset.
        if dimensions[0] in seen_widths:
            continue
        seen_widths.add(dimensions[0])
        shutil.copyfile(cached, output / "thumbnails" / name)
        variants.append({"src": f"./thumbnails/{name}", "width": dimensions[0], "height": dimensions[1]})
        report["thumbnailBytes"] += cached.stat().st_size
    report["originalCoverBytes"] += len(source)
    return variants


def build(root, output, cache):
    root, output, cache = root.resolve(), output.resolve(), cache.resolve()
    protected = [root / folder for folder in ("assets", "images", "data", "scripts", "tests", "worker", ".git", ".github")]
    if root.is_relative_to(output) or any(output.is_relative_to(path) for path in protected):
        raise ValueError("Build output must not replace source files")
    if cache.is_relative_to(output) or output.is_relative_to(cache):
        raise ValueError("Build output and cache must be separate")
    manifest = json.loads((root / "data/albums.json").read_text())
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("albums"), list):
        raise ValueError("Invalid album manifest")
    if output.exists():
        if not (output / MARKER).is_file():
            raise ValueError("Refusing to replace a directory not created by this builder")
        shutil.rmtree(output)
    output.mkdir(parents=True)
    (output / MARKER).touch()
    cache.mkdir(parents=True, exist_ok=True)
    (output / "thumbnails").mkdir()
    # Only website assets belong in the public artifact.
    for folder in ("assets", "images", "data"):
        shutil.copytree(root / folder, output / folder)
    for name in ("index.html", "404.html", "config.js", "CNAME"):
        if (root / name).is_file():
            shutil.copyfile(root / name, output / name)
    (output / ".nojekyll").touch()
    published = deepcopy(manifest)
    report = {"covers": 0, "externalCovers": 0, "generated": 0, "cached": 0, "originalCoverBytes": 0, "thumbnailBytes": 0}
    for album in published["albums"]:
        if not album.get("images"):
            raise ValueError(f"Album has no cover: {album.get('id')}")
        for entry in album["images"]:
            if isinstance(entry, dict):
                entry.pop("thumbnails", None)
        cover = album["images"][0]
        if isinstance(cover, str):
            cover = {"src": cover}
            album["images"][0] = cover
        path = local_image(root, cover["src"])
        if path is None:
            report["externalCovers"] += 1
            continue
        cover["thumbnails"] = cover_variants(path, cache, output, report)
        report["covers"] += 1
    (output / "data/albums.json").write_text(json.dumps(published, ensure_ascii=False, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, default=Path("_site"))
    parser.add_argument("--cache", type=Path, default=Path(".cache/thumbnails"))
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.output, args.cache), ensure_ascii=False))
