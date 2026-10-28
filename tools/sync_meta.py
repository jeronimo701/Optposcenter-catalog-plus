"""Synchronize the Tampermonkey metadata file with the userscript header."""
from pathlib import Path
root = Path(__file__).resolve().parents[1]
source, = root.glob("*.user.js")
raw = source.read_bytes()
header, _ = raw.split(b"// ==/UserScript==", 1)
newline = b"\r\n" if b"\r\n" in header else b"\n"
source.with_name(source.name.replace(".user.js", ".meta.js")).write_bytes(header + b"// ==/UserScript==" + newline)
