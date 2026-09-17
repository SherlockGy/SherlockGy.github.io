from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image
from scripts.build_site import build, local_image


class BuildSiteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "source"
        for folder in ("images", "assets", "data"):
            (self.root / folder).mkdir(parents=True)
        (self.root / "index.html").write_text("<title>Test</title>")
        (self.root / "worker-secret.txt").write_text("not a website asset")
        Image.new("RGB", (1200, 800), "red").save(self.root / "images/a.png")
        Image.new("RGBA", (800, 1200), (0, 0, 255, 100)).save(self.root / "images/b.png")
        self.manifest = {"schemaVersion": 1, "custom": "keep", "albums": [
            {"id": "first", "title": "First", "date": "2026-09-17", "images": [
                {"src": "./images/a.png", "alt": "Original", "custom": True}, {"src": "./images/b.png"}]}]}
        self.write_manifest()
        self.output = Path(self.temp.name) / "site"
        self.cache = Path(self.temp.name) / "cache"

    def write_manifest(self):
        (self.root / "data/albums.json").write_text(json.dumps(self.manifest))

    def published(self):
        return json.loads((self.output / "data/albums.json").read_text())

    def run_build(self):
        return build(self.root, self.output, self.cache)

    def test_every_image_gets_thumbnails_without_mutating_originals_or_source_manifest(self):
        before = {p: p.read_bytes() for p in [self.root / "data/albums.json", self.root / "images/a.png", self.root / "images/b.png"]}
        report = self.run_build()
        self.assertEqual((report["covers"], report["images"], report["generated"]), (1, 2, 4))
        published = self.published()
        cover = published["albums"][0]["images"][0]
        self.assertEqual([t["width"] for t in cover["thumbnails"]], [480, 960])
        for entry in published["albums"][0]["images"]:
            for thumb in entry["thumbnails"]:
                with Image.open(self.output / thumb["src"]) as image:
                    self.assertEqual(image.format, "WEBP")
                    self.assertEqual(image.size, (thumb["width"], thumb["height"]))
            del entry["thumbnails"]
        self.assertEqual(published, self.manifest)
        for path, original in before.items():
            self.assertEqual(path.read_bytes(), original)
        self.assertEqual((self.output / "images/a.png").read_bytes(), before[self.root / "images/a.png"])
        self.assertFalse((self.output / "worker-secret.txt").exists())

    def test_cache_reuses_content_and_reordering_or_replacement_selects_a_new_cover(self):
        self.run_build()
        first = self.published()["albums"][0]["images"][0]["thumbnails"][0]["src"]
        report = self.run_build()
        self.assertEqual((report["generated"], report["cached"]), (0, 4))
        self.manifest["albums"][0]["images"].reverse()
        self.write_manifest()
        self.run_build()
        replacement = self.published()["albums"][0]["images"][0]["thumbnails"][0]
        self.assertNotEqual(first, replacement["src"])
        with Image.open(self.output / replacement["src"]) as image:
            self.assertEqual(image.mode, "RGBA")
            self.assertGreater(image.height, image.width)
        Image.new("RGB", (800, 1200), "green").save(self.root / "images/b.png")
        self.run_build()
        self.assertNotEqual(replacement["src"], self.published()["albums"][0]["images"][0]["thumbnails"][0]["src"])

    def test_legacy_strings_small_animated_images_and_external_images(self):
        Image.new("RGB", (20, 10), "red").save(self.root / "images/tiny.gif", save_all=True, append_images=[Image.new("RGB", (20, 10), "blue")], duration=100, loop=0)
        self.manifest["albums"][0]["images"] = ["./images/tiny.gif"]
        external = deepcopy(self.manifest["albums"][0]); external["id"] = "external"; external["images"] = ["https://example.com/external.png"]
        self.manifest["albums"].append(external); self.write_manifest()
        self.assertEqual(self.run_build()["externalCovers"], 1)
        images = self.published()["albums"]
        thumbs = images[0]["images"][0]["thumbnails"]
        self.assertEqual(len(thumbs), 1); self.assertEqual(thumbs[0]["width"], 20)
        with Image.open(self.output / thumbs[0]["src"]) as image:
            self.assertFalse(getattr(image, "is_animated", False))
        self.assertNotIn("thumbnails", images[1]["images"][0])

    def test_exif_orientation_is_applied_to_the_thumbnail(self):
        exif = Image.Exif(); exif[274] = 6
        Image.new("RGB", (1200, 800), "yellow").save(self.root / "images/rotated.jpg", exif=exif)
        self.manifest["albums"][0]["images"] = ["./images/rotated.jpg"]; self.write_manifest()
        self.run_build()
        thumb = self.published()["albums"][0]["images"][0]["thumbnails"][0]
        self.assertEqual((thumb["width"], thumb["height"]), (480, 720))

    def test_missing_corrupt_or_escaping_local_covers_fail_the_build(self):
        for path in ("../outside.png", "./images/missing.png", "./assets/app.js"):
            with self.assertRaises(ValueError): local_image(self.root, path)
        (self.root / "images/broken.png").write_bytes(b"broken")
        self.manifest["albums"][0]["images"] = ["./images/broken.png"]; self.write_manifest()
        with self.assertRaises(OSError): self.run_build()

    def test_output_guard_preserves_existing_directories(self):
        with self.assertRaises(ValueError): build(self.root, self.root, self.cache)
        self.output.mkdir(); (self.output / "keep.txt").write_text("keep")
        with self.assertRaises(ValueError): self.run_build()
        self.assertEqual((self.output / "keep.txt").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
