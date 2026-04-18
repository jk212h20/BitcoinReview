// QR + deep-link integration test for the homepage donation panels.
// Catches:
//   1. EJS template-literal escape regressions in src/views/index.ejs
//      (any \n inside a JS string inside the body literal silently breaks
//      the inline <script> — Alpine/JS never hydrates).
//   2. Missing <a href="lightning:..."> / "bitcoin:..." deep-link wrappers.
//   3. Missing QR container divs or vendored qrcode.min.js script tag.
//   4. Vendored qrcode.min.js failing to actually generate an SVG when
//      called the way the page calls it.
//
// Run with: node src/tests/qr-deeplink.test.js

const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');

const SAMPLE_BOLT11 =
  'lnbc100n1pjqxxxxpp5kxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxqdqqcqzpgxqyz5vqsp5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxs9q9qxpqysgqxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxgqxxxxxx';
const SAMPLE_ADDR = 'bc1qexampleexampleexampleexampleexampleexamx0';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  ok  ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

function main() {
  console.log('Rendering src/views/index.ejs with stub locals...');
  const tmpl = fs.readFileSync(path.join(VIEWS, 'index.ejs'), 'utf8');
  const html = ejs.render(
    tmpl,
    {
      title: 'Reviews Raffle',
      onchainAddress: SAMPLE_ADDR,
      lightningInvoice: SAMPLE_BOLT11,
      raffleInfo: {
        nextRaffleBlock: 900000,
        blocksUntilNext: 100,
        timeEstimate: '~16h',
      },
      contact: { telegram: '', whatsapp: '', email: '' },
      location: null,
      siteName: 'Reviews Raffle',
    },
    { views: [VIEWS], filename: path.join(VIEWS, 'index.ejs') }
  );

  console.log('\n[1] HTML structural assertions');
  check('vendored qrcode script tag present',
    html.includes('/vendor/qrcode.min.js'));
  check('Lightning deep-link anchor present',
    html.includes('href="lightning:' + SAMPLE_BOLT11 + '"'),
    'expected anchor with literal BOLT11');
  check('on-chain deep-link anchor present',
    html.includes('href="bitcoin:' + SAMPLE_ADDR + '"'));
  check('Lightning QR container present',
    html.includes('id="ln-qr"'));
  check('on-chain QR container present',
    html.includes('id="onchain-qr"'));
  check('custom-amount QR container present',
    html.includes('id="custom-ln-qr"'));
  check('custom-amount deep-link anchor scaffold present',
    html.includes('id="custom-ln-link"'));
  check('no remote QR-server image leaked through',
    !html.includes('api.qrserver.com'),
    'all QR rendering should be local');
  check('"Tap QR" affordance shown at least twice',
    (html.match(/Tap QR to open your wallet/g) || []).length >= 2);

  console.log('\n[2] Inline <script> blocks parse cleanly (catches EJS escape bug)');
  const scriptBlocks = [];
  const re = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    // Skip <script src="..."> with no body
    if (m[1].trim().length === 0) continue;
    scriptBlocks.push(m[1]);
  }
  check('at least one inline <script> block found', scriptBlocks.length >= 1,
    'found ' + scriptBlocks.length);
  scriptBlocks.forEach(function (body, i) {
    let parseOk = true;
    let err = '';
    try {
      // new Function throws a SyntaxError if the body is not valid JS,
      // matching what `node --check` would report for the script content.
      // eslint-disable-next-line no-new-func
      new Function(body);
    } catch (e) {
      parseOk = false;
      err = e.message;
    }
    check('inline script #' + (i + 1) + ' parses', parseOk, err);
  });

  console.log('\n[3] Vendored qrcode.min.js can render the page payloads');
  const qrCode = fs.readFileSync(
    path.join(ROOT, 'public', 'vendor', 'qrcode.min.js'),
    'utf8'
  );
  // Minimal browserish sandbox: qrcode.js attaches to `this` (window) when
  // no module system is detected. Provide an empty global object as `this`.
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(qrCode, sandbox);
  check('qrcode global is a function',
    typeof sandbox.qrcode === 'function');

  function makeSvg(data) {
    const qr = sandbox.qrcode(0, 'L');
    qr.addData(data);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }

  let lnSvg = '';
  let addrSvg = '';
  try {
    lnSvg = makeSvg(SAMPLE_BOLT11.toUpperCase());
    addrSvg = makeSvg(SAMPLE_ADDR);
  } catch (e) {
    check('qrcode.createSvgTag does not throw', false, e.message);
  }
  check('Lightning SVG is non-trivial', lnSvg.length > 500,
    'len=' + lnSvg.length);
  check('Lightning SVG starts with <svg', lnSvg.startsWith('<svg'));
  check('on-chain SVG is non-trivial', addrSvg.length > 500,
    'len=' + addrSvg.length);

  console.log('\n[4] renderQR helper from index.ejs works against a fake DOM');
  // Extract just the renderQR-defining script (from index.ejs) — skip layout
  // script blocks which use lots of browser APIs we'd need to stub.
  const qrScript = scriptBlocks.find(function (b) { return b.indexOf('function renderQR') !== -1; }) || '';
  check('renderQR-defining script block found in output', qrScript.length > 0);
  const fakeEl = {
    innerHTML: '',
    querySelector: function () { return { setAttribute: function () {} }; },
  };
  sandbox.document = {
    readyState: 'complete',
    getElementById: function (id) { return id === 'probe' ? fakeEl : null; },
    addEventListener: function () {},
  };
  sandbox.window = { addEventListener: function () {} };
  sandbox.fetch = function () { return Promise.resolve({ json: function () { return {}; } }); };
  sandbox.alert = function () {};
  sandbox.setTimeout = setTimeout;
  sandbox.navigator = { clipboard: { writeText: function () { return Promise.resolve(); } } };
  // Inject a wrapper that exposes renderQR after eval.
  vm.runInContext(qrScript + '\n;globalThis.__renderQR = renderQR;', sandbox);
  check('renderQR exported into sandbox',
    typeof sandbox.__renderQR === 'function');
  fakeEl.innerHTML = '';
  sandbox.__renderQR('probe', SAMPLE_BOLT11.toUpperCase());
  check('renderQR populated container with <svg>',
    fakeEl.innerHTML.indexOf('<svg') === 0,
    'innerHTML[0..40]=' + fakeEl.innerHTML.substring(0, 40));

  console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') +
    ' — ' + failures + ' failure(s)');
  process.exit(failures === 0 ? 0 : 1);
}

try { main(); } catch (e) {
  console.error('test crashed:', e);
  process.exit(2);
}
