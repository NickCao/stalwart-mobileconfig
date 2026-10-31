"""Command-line entry point."""

import argparse
import plistlib
import sys
from pathlib import Path
from urllib.error import URLError

from .configuration import ConfigurationError, discover, email_address
from .profile import make_profile


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Generate an Apple Mail and CalDAV profile from Stalwart autoconfiguration."
    )
    parser.add_argument(
        "email", help="Full email address; also used as the account username"
    )
    parser.add_argument(
        "--name", help="Display name for outgoing mail (defaults to the email address)"
    )
    parser.add_argument(
        "-o", "--output", type=Path, help="Write a .mobileconfig file instead of stdout"
    )
    args = parser.parse_args(argv)
    try:
        email = email_address(args.email)
        profile = make_profile(email, discover(email), args.name)
        data = plistlib.dumps(profile, fmt=plistlib.FMT_XML, sort_keys=False)
        if args.output is None:
            sys.stdout.buffer.write(data)
        else:
            args.output.write_bytes(data)
    except (ConfigurationError, URLError, OSError, ValueError) as error:
        parser.exit(1, f"{parser.prog}: {error}\n")
