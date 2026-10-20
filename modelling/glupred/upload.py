"""Uploads a prediction model to a loopk server (PUT /api/prediction/model).

The token is an "Upload model" access token (the server's Access page, or
`npm run token -- create <name> model`). URL and token come from the
arguments, else from LOOPK_URL and LOOPK_MODEL_TOKEN.
"""

import json
import os
import urllib.error
import urllib.request


def resolve(url=None, token=None):
    """(url, token) from the arguments or the environment."""
    url = url or os.environ.get('LOOPK_URL')
    token = token or os.environ.get('LOOPK_MODEL_TOKEN')
    if not url:
        raise SystemExit('No server: pass --url or set LOOPK_URL (e.g. https://loopk.robertbuessow.com).')
    if not token:
        raise SystemExit('No token: pass --token or set LOOPK_MODEL_TOKEN to an "Upload model" access token.')
    return url.rstrip('/'), token


def upload(model, url=None, token=None):
    """Uploads `model` (the exported dict) and returns the server's report."""
    url, token = resolve(url, token)
    try:
        with urllib.request.urlopen(f'{url}/api/v2/authorization/request/{token}') as r:
            jwt = json.load(r)['token']
    except urllib.error.HTTPError as err:
        raise SystemExit(f'{url} does not know this token ({err.code}). A token created with '
                         '`npm run token` only counts after the server restarts.')
    except urllib.error.URLError as err:
        raise SystemExit(f'cannot reach {url}: {err.reason}')
    req = urllib.request.Request(f'{url}/api/prediction/model', data=json.dumps(model).encode(), method='PUT',
                                 headers={'Authorization': f'Bearer {jwt}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r:
            info = json.load(r)
    except urllib.error.HTTPError as err:
        body = err.read().decode()
        if err.code == 403:
            raise SystemExit(f'upload refused (403): this token may not upload models; create one with access '
                             f'"Upload model" under Access on {url}/admin')
        try:
            problems = json.loads(body).get('problems') or []
        except ValueError:
            problems = []
        raise SystemExit(f'upload refused ({err.code}): ' + ('; '.join(problems) if problems else body))
    print(f'uploaded model {info["version"]} (id {info["id"]}) to {url}')
    return info
