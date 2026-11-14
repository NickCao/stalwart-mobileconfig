"""Package the static frontend for Stalwart's application manager."""

import argparse
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"


def build(output: Path) -> Path:
    manifest = json.loads((WEB / "stalwart-app.json").read_text())
    client = json.loads((WEB / "oauth-client.json").read_text())
    if "client_id" in client or "client_secret" in client:
        raise ValueError("The bundled OAuth document must be a template without credentials")
    for redirect in client["redirect_uris"]:
        if not redirect or redirect.startswith("/") or ":" in redirect or ".." in redirect:
            raise ValueError("OAuth redirects must be paths relative to the installed app")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(WEB.iterdir()):
            if path.is_file() and path.suffix in {".html", ".css", ".js", ".json", ".svg"}:
                info = zipfile.ZipInfo(path.name, (2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                archive.writestr(info, path.read_bytes())
    print(f"Built {output} ({manifest['id']} {manifest['version']})")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-o", "--output", type=Path, default=ROOT / "dist" / "stalwart-mobileconfig.zip"
    )
    build(parser.parse_args().output)


if __name__ == "__main__":
    main()
