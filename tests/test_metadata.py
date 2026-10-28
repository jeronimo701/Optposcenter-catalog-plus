import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class MetadataTests(unittest.TestCase):
    def test_update_header_matches_script(self):
        source, = ROOT.glob("*.user.js")
        header = source.read_bytes().split(b"// ==/UserScript==", 1)[0] + b"// ==/UserScript=="
        self.assertEqual(header, source.with_name(source.name.replace(".user.js", ".meta.js")).read_bytes().rstrip(b"\r\n"))

    def test_public_update_urls(self):
        source, = ROOT.glob("*.user.js")
        header = source.read_text(encoding="utf-8").split("// ==/UserScript==", 1)[0]
        expected = "https://raw.githubusercontent.com/jeronimo701/Optposcenter-catalog-plus/main/"
        for field, suffix in (("updateURL", ".meta.js"), ("downloadURL", ".user.js")):
            match = re.search(r"^//\s*@" + field + r"\s+(\S+)", header, re.M)
            self.assertIsNotNone(match)
            self.assertEqual(match[1], expected + source.name.replace(".user.js", suffix))

    def test_version_and_identity_present(self):
        source, = ROOT.glob("*.user.js")
        header = source.read_text(encoding="utf-8").split("// ==/UserScript==", 1)[0]
        for field in ("name", "namespace", "version"):
            self.assertRegex(header, r"(?m)^//\s*@" + field + r"\s+\S+")

if __name__ == "__main__":
    unittest.main()
