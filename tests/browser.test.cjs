const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startFixtureServer } = require('./browser-server.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function findBrowser() {
    const candidates = [];
    if (process.env.RC_BROWSER_PATH) candidates.push(process.env.RC_BROWSER_PATH);
    if (process.platform === 'win32') {
        for (const base of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]) {
            if (!base) continue;
            candidates.push(
                path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            );
        }
    } else if (process.platform === 'darwin') {
        candidates.push(
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        );
    } else {
        candidates.push(
            '/usr/bin/microsoft-edge',
            '/usr/bin/microsoft-edge-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
        );
    }
    return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

function waitForDevtoolsEndpoint(browser) {
    return new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Browser did not expose CDP in time.\n${output}`));
        }, 15000);
        const cleanup = () => {
            clearTimeout(timer);
            browser.stderr.off('data', onData);
            browser.off('exit', onExit);
        };
        const onData = chunk => {
            output += chunk.toString();
            const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
            if (!match) return;
            cleanup();
            resolve(match[1]);
        };
        const onExit = (code, signal) => {
            cleanup();
            reject(new Error(`Browser exited before CDP became ready (code=${code}, signal=${signal}).\n${output}`));
        };
        browser.stderr.on('data', onData);
        browser.once('exit', onExit);
    });
}

async function createPageTarget(devtoolsUrl, pageUrl) {
    const endpoint = new URL(devtoolsUrl);
    endpoint.protocol = 'http:';
    const targetUrl = new URL('/json/new', endpoint);
    targetUrl.searchParams.set('url', pageUrl);
    const response = await fetch(targetUrl, { method: 'PUT' });
    if (!response.ok) throw new Error(`Could not create browser target: HTTP ${response.status}`);
    const target = await response.json();
    if (!target.webSocketDebuggerUrl) throw new Error('Browser target has no WebSocket URL');
    return target.webSocketDebuggerUrl;
}

class CdpClient {
    constructor(url) {
        this.url = url;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        this.socket = null;
    }

    async connect() {
        this.socket = new WebSocket(this.url);
        this.socket.addEventListener('message', event => this.onMessage(String(event.data)));
        this.socket.addEventListener('close', () => {
            for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'));
            this.pending.clear();
        });
        await new Promise((resolve, reject) => {
            this.socket.addEventListener('open', resolve, { once: true });
            this.socket.addEventListener('error', () => reject(new Error('Could not connect to CDP')), { once: true });
        });
    }

    on(method, listener) {
        const entries = this.listeners.get(method) || [];
        entries.push(listener);
        this.listeners.set(method, entries);
        return () => this.listeners.set(method, (this.listeners.get(method) || []).filter(fn => fn !== listener));
    }

    onMessage(raw) {
        const message = JSON.parse(raw);
        if (message.id) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
            else pending.resolve(message.result || {});
            return;
        }
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
    }

    send(method, params = {}) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP is not connected'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, method });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    async evaluate(expression) {
        const response = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
        });
        if (response.exceptionDetails) {
            const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
            throw new Error(`Page evaluation failed: ${detail}`);
        }
        return response.result?.value;
    }

    close() {
        this.socket?.close();
    }
}

async function waitFor(probe, label, timeout = 8000) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const value = typeof probe === 'function' ? await probe() : await probe;
            if (value) return value;
        } catch (err) {
            lastError = err;
        }
        await delay(50);
    }
    throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function frameDocumentExpression(depth) {
    return `(() => {
        let doc = document;
        for (let i = 0; i < ${depth}; i++) {
            const frame = doc.getElementById('course-frame');
            if (!frame || !frame.contentDocument) throw new Error(\`Course frame \${i + 1} is unavailable\`);
            doc = frame.contentDocument;
        }
        return doc;
    })()`;
}

async function clickInFrame(cdp, depth, id) {
    const doc = frameDocumentExpression(depth);
    const clicked = await cdp.evaluate(`(() => {
        const element = (${doc}).getElementById(${JSON.stringify(id)});
        if (!element) return false;
        element.click();
        return true;
    })()`);
    assert.equal(clicked, true, `Expected #${id} in frame depth ${depth}`);
}

async function waitForText(cdp, selector, expected, timeout) {
    return waitFor(() => cdp.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.textContent || '').includes(${JSON.stringify(expected)})`), `${selector} to contain ${expected}`, timeout);
}

async function closeBrowser(browser, cdp) {
    try { await Promise.race([cdp?.send('Browser.close'), delay(1000)]); } catch (err) {}
    if (browser && browser.exitCode === null) browser.kill();
    if (browser && browser.exitCode === null) {
        await Promise.race([
            new Promise(resolve => browser.once('exit', resolve)),
            delay(3000),
        ]);
    }
}

async function removeProfile(profileDir) {
    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            await fsp.rm(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            return;
        } catch (err) {
            await delay(150);
        }
    }
}

test('headless browser fixture covers userscript injection and classroom flows', { timeout: 120000 }, async t => {
    if (typeof WebSocket !== 'function') {
        t.skip('Node.js 22 or newer is required for the built-in CDP WebSocket client');
        return;
    }
    const browserPath = findBrowser();
    if (!browserPath) {
        t.skip('Microsoft Edge or Google Chrome was not found; set RC_BROWSER_PATH to run this test');
        return;
    }

    const fixture = await startFixtureServer();
    const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rc-browser-test-'));
    let browser;
    let cdp;
    const runtimeErrors = [];
    const consoleErrors = [];
    try {
        browser = spawn(browserPath, [
            '--headless=new',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-sync',
            '--no-first-run',
            '--no-default-browser-check',
            '--remote-debugging-port=0',
            '--remote-allow-origins=*',
            `--user-data-dir=${profileDir}`,
            'about:blank',
        ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

        const devtoolsUrl = await waitForDevtoolsEndpoint(browser);
        const pageSocket = await createPageTarget(devtoolsUrl, 'about:blank');
        cdp = new CdpClient(pageSocket);
        await cdp.connect();
        cdp.on('Runtime.exceptionThrown', event => {
            runtimeErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Unknown page exception');
        });
        cdp.on('Runtime.consoleAPICalled', event => {
            if (event.type === 'error') consoleErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' '));
        });
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await cdp.send('Page.navigate', { url: fixture.url });

        await waitFor(() => cdp.evaluate(`document.readyState === 'complete'`), 'fixture document to load');
        await waitFor(() => cdp.evaluate(`!!document.getElementById('rc-panel-container')`), 'top-level panel injection').catch(err => {
            throw new Error(`${err.message}\nRuntime errors: ${JSON.stringify(runtimeErrors)}\nConsole errors: ${JSON.stringify(consoleErrors)}`);
        });
        await waitFor(() => cdp.evaluate(`(() => {
            const first = document.getElementById('course-frame')?.contentDocument;
            const second = first?.getElementById('course-frame')?.contentDocument;
            return first?.readyState === 'complete' && second?.readyState === 'complete';
        })()`), 'nested classroom frames');

        const panelCounts = await cdp.evaluate(`(() => {
            const counts = [];
            const visit = doc => {
                counts.push(doc.querySelectorAll('#rc-panel-container').length);
                for (const frame of doc.querySelectorAll('iframe')) {
                    if (frame.contentDocument) visit(frame.contentDocument);
                }
            };
            visit(document);
            return counts;
        })()`);
        assert.deepEqual(panelCounts, [1, 0, 0]);
        assert.match(await cdp.evaluate(`document.getElementById('rc-panel-header').textContent`), /雨课堂助手\s*1\.3\.0/);

        await clickInFrame(cdp, 0, 'login');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-panel-container').style.display === 'none'`), 'QR overlay to hide panel');
        await clickInFrame(cdp, 0, 'login');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-panel-container').style.display === 'flex'`), 'panel after closing QR overlay');
        await clickInFrame(cdp, 0, 'spa-login');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-panel-container').style.display === 'none'`), 'SPA login route to hide panel');
        await clickInFrame(cdp, 0, 'spa-course');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-panel-container').style.display === 'flex'`), 'panel after SPA course route');

        await clickInFrame(cdp, 0, 'duplicate');
        await delay(250);
        assert.equal(await cdp.evaluate(`document.querySelectorAll('#rc-panel-container').length`), 1, 'duplicate injection must remain idempotent');

        await clickInFrame(cdp, 2, 'capture');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-pending-total').textContent === '1'`), 'fetch courseware capture in a nested frame');
        await clickInFrame(cdp, 2, 'capture-direct-ppt');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-pending-total').textContent === '2'`), 'first direct PPT capture');
        await clickInFrame(cdp, 2, 'capture-direct-ppt-2');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-pending-total').textContent === '3'`), 'second direct PPT capture');
        await clickInFrame(cdp, 2, 'capture-video');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-pending-total').textContent === '4'`), 'video source capture');
        assert.equal(await cdp.evaluate(`document.querySelectorAll('#rc-pending-list .rc-pending-item').length`), 4);
        assert.match(await cdp.evaluate(`document.getElementById('rc-pending-list').textContent`), /\[课件\][\s\S]*\[录播\]/);

        const checkbox = await cdp.evaluate(`(() => {
            const input = document.querySelector('#rc-pending-list input[type="checkbox"]');
            const style = getComputedStyle(input);
            const rect = input.getBoundingClientRect();
            return { appearance: style.appearance, width: rect.width, height: rect.height };
        })()`);
        assert.notEqual(checkbox.appearance, 'none');
        assert.ok(checkbox.width >= 12 && checkbox.height >= 12, `Checkbox is too small: ${JSON.stringify(checkbox)}`);

        await cdp.evaluate(`document.querySelector('#rc-pending-list input[type="checkbox"]').click()`);
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-pending-checked').textContent === '3'`), 'individual checkbox deselection');
        await clickInFrame(cdp, 0, 'rc-btn-deselect-all');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-pending-checked').textContent === '0'`), 'deselect all');
        await clickInFrame(cdp, 0, 'rc-btn-select-all');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-pending-checked').textContent === '4'`), 'select all');
        await cdp.evaluate(`document.querySelector('#rc-pending-list input[type="checkbox"]').click()`);
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-btn-download').textContent.includes('3')`), 'download button count');

        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
        await waitFor(() => cdp.evaluate(`window.innerWidth === 320`), 'mobile viewport');
        const mobilePanel = await cdp.evaluate(`(() => {
            const rect = document.getElementById('rc-panel-container').getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth };
        })()`);
        assert.ok(mobilePanel.left >= 0 && mobilePanel.right <= mobilePanel.viewport + 0.5, `Panel overflows mobile viewport: ${JSON.stringify(mobilePanel)}`);
        await cdp.send('Emulation.clearDeviceMetricsOverride');

        await clickInFrame(cdp, 0, 'network-success');
        await clickInFrame(cdp, 0, 'rc-btn-download');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-pending-total').textContent === '1' && document.getElementById('rc-pending-checked').textContent === '0'`), 'selected jobs to leave pending list').catch(async err => {
            const state = await cdp.evaluate(`({
                pending: document.getElementById('rc-pending-total').textContent,
                checked: document.getElementById('rc-pending-checked').textContent,
                button: document.getElementById('rc-btn-download').textContent,
                disabled: document.getElementById('rc-btn-download').disabled,
                logs: document.getElementById('rc-panel-log').textContent,
                network: document.getElementById('network-success').checked,
            })`);
            throw new Error(`${err.message}\nState: ${JSON.stringify(state)}\nRuntime errors: ${JSON.stringify(runtimeErrors)}`);
        });
        await waitFor(() => cdp.evaluate(`window.fixtureDiagnostics.saveRequests() >= 1`), 'first save request', 15000);
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-unsaved-count').textContent === '3'`), 'all downloaded files to wait for save confirmation');
        await clickInFrame(cdp, 0, 'save-failure');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-completed-count').textContent === '0'`), 'failed save to remain unconfirmed');
        await waitFor(() => cdp.evaluate(`window.fixtureDiagnostics.saveRequests() >= 2`), 'second save request', 15000);
        await clickInFrame(cdp, 0, 'save-success');
        await waitFor(() => cdp.evaluate(`window.fixtureDiagnostics.saveRequests() >= 3`), 'third save request', 15000);
        await clickInFrame(cdp, 0, 'save-success');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-completed-count').textContent === '2' && document.getElementById('rc-unsaved-count').textContent === '1'`), 'confirmed and retained saves');
        const retried = await cdp.evaluate(`(() => {
            const button = [...document.querySelectorAll('#rc-save-list button')].find(item => item.textContent.includes('重试保存'));
            if (!button) return false;
            button.click();
            return true;
        })()`);
        assert.equal(retried, true, 'A failed export should expose a retry button');
        await waitFor(() => cdp.evaluate(`window.fixtureDiagnostics.saveRequests() >= 4`), 'retry save request', 15000);
        await clickInFrame(cdp, 0, 'save-success');
        await waitFor(() => cdp.evaluate(`document.getElementById('rc-completed-count').textContent === '3' && document.getElementById('rc-unsaved-count').textContent === '0'`), 'retry to confirm all files');

        await clickInFrame(cdp, 0, 'rc-tab-answer');
        await cdp.evaluate(`(() => {
            document.getElementById('rc-quiz-enabled').click();
            document.getElementById('rc-quiz-mode').value = 'random';
            document.getElementById('rc-quiz-delay').value = '0.1';
            document.getElementById('rc-quiz-form').requestSubmit();
        })()`);
        await waitForText(cdp, '#rc-quiz-status', '已开启', 5000);
        await clickInFrame(cdp, 2, 'quiz-publish');
        await waitForText(cdp, '#rc-quiz-results', '提交成功', 8000);
        const submission = await waitFor(() => cdp.evaluate(`(() => {
            const first = document.getElementById('course-frame')?.contentWindow;
            const inner = first?.document.getElementById('course-frame')?.contentWindow;
            const item = inner?.fixtureSubmissions?.[0];
            return item ? { count: inner.fixtureSubmissions.length, url: item.url, payload: item.payload } : null;
        })()`), 'source-frame quiz submission');
        assert.equal(submission.count, 1);
        assert.equal(submission.url, '/api/v3/lesson/problem/answer');
        assert.match(submission.payload.problemId, /^fixture-/);
        assert.equal(submission.payload.problemType, 1);
        assert.ok(['A', 'B'].includes(submission.payload.result[0]));

        assert.deepEqual(runtimeErrors, []);
        assert.deepEqual(consoleErrors, []);
        assert.deepEqual(await cdp.evaluate(`window.fixtureDiagnostics.errors`), []);
    } finally {
        await closeBrowser(browser, cdp);
        cdp?.close();
        await new Promise(resolve => fixture.server.close(resolve));
        await removeProfile(profileDir);
    }
});
