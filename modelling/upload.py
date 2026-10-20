"""Uploads an exported prediction model to a loopk server.

    uv run python upload.py --url https://loopk.robertbuessow.com --token <token>
    LOOPK_URL=... LOOPK_MODEL_TOKEN=... uv run python upload.py [results/model.json]

The token is an "Upload model" access token from the server's Access page.
Arguments override the environment. The default model file is the one
export.py writes. The server reruns the model's bundled checks first and
refuses it if they do not come out the same.
"""

import argparse
import json
from pathlib import Path

from glupred.upload import upload

DEFAULT = Path(__file__).resolve().parent / 'results' / 'model.json'


def main():
    ap = argparse.ArgumentParser(description='Upload a prediction model to a loopk server.')
    ap.add_argument('model', nargs='?', type=Path, default=DEFAULT, help=f'model file (default: {DEFAULT.name} from export.py)')
    ap.add_argument('--url', help='server, e.g. https://loopk.robertbuessow.com (default: $LOOPK_URL)')
    ap.add_argument('--token', help='"Upload model" access token (default: $LOOPK_MODEL_TOKEN)')
    args = ap.parse_args()
    if not args.model.exists():
        raise SystemExit(f'{args.model} does not exist; run `uv run python export.py` first.')
    upload(json.loads(args.model.read_text()), args.url, args.token)


if __name__ == '__main__':
    main()
