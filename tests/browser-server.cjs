// Local-only UI regression fixture. No requests are sent to Rain Classroom.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function createFixtureServer() {
    return http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const script = url.pathname === '/main.js';
        const loader = url.pathname === '/userscript-loader.js';
        res.writeHead(200, {
            'Content-Type': script || loader ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        if (loader) {
            // Unlike a plain <script>, userscript `window` is not necessarily the
            // page WindowProxy, and changing sandbox.fetch need not affect the page.
            const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
            res.end(`(() => {
                const sandbox = { top: window.top, fetch: async () => { throw new Error('Sandbox fetch must not be used'); },
                    addEventListener: window.addEventListener.bind(window), jspdf: window.jspdf };
                sandbox.window = sandbox.self = sandbox;
                new Function('window', 'unsafeWindow', ${JSON.stringify(source)})(sandbox, window);
            })();`);
            return;
        }
        res.end(fs.readFileSync(script ? path.join(root, 'main.js') : path.join(__dirname, 'browser-fixture.html')));
    });
}

function startFixtureServer({ port = 0, host = '127.0.0.1' } = {}) {
    const server = createFixtureServer();
    return new Promise((resolve, reject) => {
        const onError = err => { server.off('listening', onListening); reject(err); };
        const onListening = () => {
            server.off('error', onError);
            resolve({ server, url: `http://${host}:${server.address().port}/` });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

module.exports = { createFixtureServer, startFixtureServer };

if (require.main === module) {
    startFixtureServer({ port: Number(process.env.RC_TEST_PORT || 0) }).then(({ url }) => {
        console.log(`UI fixture: ${url}`);
    }).catch(err => {
        console.error(err);
        process.exitCode = 1;
    });
}
