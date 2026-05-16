import base64, json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROMPT_PATH = ROOT / 'merchant-poster-gpt-image-2.prompt.txt'
OUT_JSON = ROOT / 'merchant-poster-gpt-image-2.response.json'
OUT_IMG = ROOT / 'merchant-poster-gpt-image-2.png'
LOG = ROOT / 'merchant-poster-gpt-image-2.log'

API_KEY = os.environ.get('PPQ_API_KEY')
if not API_KEY:
    # Fallback to pi auth file if env is not exported in shell.
    auth_path = Path.home() / '.pi/agent/auth.json'
    if auth_path.exists():
        auth = json.loads(auth_path.read_text())
        API_KEY = auth.get('ppq', {}).get('key')
if not API_KEY:
    raise SystemExit('Missing PPQ_API_KEY and ~/.pi/agent/auth.json ppq key')

prompt = PROMPT_PATH.read_text()
payload = {
    'model': 'gpt-image-2',
    'prompt': prompt,
    'image_size': 'portrait_16_9',
    'quality': 'high',
    'n': 1,
    'output_format': 'png'
}

with LOG.open('w') as log:
    def say(msg):
        print(msg, flush=True)
        print(msg, flush=True, file=log)

    say('Submitting image generation to PPQ /v1/images/generations...')
    say('model=gpt-image-2 image_size=portrait_16_9 quality=high output_format=png')

    req = urllib.request.Request(
        'https://api.ppq.ai/v1/images/generations',
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'Authorization': f'Bearer {API_KEY}',
            'Content-Type': 'application/json',
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = resp.read().decode('utf-8')
            say(f'HTTP {resp.status}')
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        say(f'HTTP ERROR {e.code}')
        say(body)
        OUT_JSON.write_text(body)
        raise SystemExit(1)

    OUT_JSON.write_text(body)
    say(f'Saved raw response: {OUT_JSON}')

    data = json.loads(body)
    if data.get('message') and not data.get('data'):
        say('PPQ returned message/error: ' + str(data.get('message')))
        raise SystemExit(1)

    # PPQ/OpenAI-ish image responses vary by model/gateway. Try common shapes.
    items = data.get('data')
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list):
        items = []

    image_url = None
    b64 = None
    for item in items:
        if not isinstance(item, dict):
            continue
        image_url = item.get('url') or item.get('image_url') or item.get('b64_json_url')
        b64 = item.get('b64_json') or item.get('base64') or item.get('image_base64')
        if image_url or b64:
            break

    # Some gateways return top-level output/url.
    image_url = image_url or data.get('url') or data.get('image_url')
    b64 = b64 or data.get('b64_json') or data.get('base64')

    if b64:
        OUT_IMG.write_bytes(base64.b64decode(b64))
        say(f'Decoded image to: {OUT_IMG}')
    elif image_url:
        say(f'Downloading image URL: {image_url}')
        img_req = urllib.request.Request(image_url, headers={'User-Agent': 'BitcoinReviewPoster/1.0'})
        with urllib.request.urlopen(img_req, timeout=120) as img_resp:
            OUT_IMG.write_bytes(img_resp.read())
        say(f'Downloaded image to: {OUT_IMG}')
    else:
        say('Could not find image URL or base64 in response. Inspect JSON manually.')
        raise SystemExit(2)

    say('Done.')
