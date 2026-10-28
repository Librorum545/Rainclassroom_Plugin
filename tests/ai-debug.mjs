#!/usr/bin/env node
// One real AI round-trip through the production quiz code in main.js.
//
// PowerShell example:
//   $env:RC_AI_API_KEY = 'sk-...'
//   node tests/ai-debug.mjs --base-url https://open.bigmodel.cn/api/paas/v4 --model glm-5.3-flash `
//     --question "以下哪个是质数？" --type 1 --option A=4 --option B=7 --option C=9
//   # 带题目图片：
//   node tests/ai-debug.mjs --base-url ... --model ... --question "..." `
//     --option A=... --option B=... --image "[path]"
//
// The script loads main.js in a Node VM, replaces only the browser/manager
// globals, and calls the same askQuizAI()/parseAIAnswer() path used by the
// userscript. It prints the outgoing payload, the raw HTTP body and the parsed
// answer so malformed model output can be diagnosed without a live classroom.

import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, '..', 'main.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const DEBUG_IMAGE_URL = 'https://fe-static-yuketang.yuketang.cn/debug-image';
const version = (/^\/\/\s*@version\s+(\S+)\s*$/m.exec(source) || [])[1] || 'unknown';

function usage() {
    return `
用法：
  $env:RC_AI_API_KEY = 'sk-...'
  node tests/ai-debug.mjs --base-url <URL> --model <模型> [--question <题干>] \
    --option A=<选项文本> --option B=<选项文本> [--type 1|2] [--timeout 30] [--image <路径>]

参数：
  --base-url   必填，/chat/completions 的 Base URL（本机 HTTP 服务也可）
  --model      必填，模型 ID
  --api-key    可选；缺省时读取 RC_AI_API_KEY，避免把密钥写进命令历史
  --question   题干；只发图片时可省略或留空（需配合 --image）
  --option     可重复，KEY=VALUE；只写 KEY 表示空选项文本；至少一个
  --type       1=单选（默认），2=多选
  --timeout    秒，默认 30
  --image      可选，本地 PNG/JPEG/WebP/GIF；会按主程序的图片逻辑转成 data URL 发送
  --help       显示本帮助
`.trim();
}

function parseArgs(argv) {
    const out = { type: 1, timeout: 30, options: [], question: '' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = (allowEmpty = false) => {
            const next = argv[i + 1];
            if (next === undefined || (allowEmpty && next.startsWith('--'))) {
                if (allowEmpty) return '';
                throw new Error(`${arg} 缺少参数值`);
            }
            i++;
            return next;
        };
        switch (arg) {
            case '--base-url': out.baseURL = value(); break;
            case '--model': out.model = value(); break;
            case '--api-key': out.apiKey = value(); break;
            case '--question': out.question = value(true); break;
            case '--type': out.type = Number(value()); break;
            case '--timeout': out.timeout = Number(value()); break;
            case '--image': out.image = value(); break;
            case '--option': {
                const raw = value();
                const at = raw.indexOf('=');
                if (at < 0) {
                    const key = raw.trim();
                    if (!/^[A-Z0-9]{1,8}$/.test(key)) throw new Error('--option 需要 KEY=VALUE 或 KEY 格式');
                    out.options.push({ key, value: '' });
                } else {
                    if (at < 1) throw new Error('--option 需要 KEY=VALUE 格式');
                    out.options.push({ key: raw.slice(0, at).trim(), value: raw.slice(at + 1) });
                }
                break;
            }
            case '--help': case '-h': out.help = true; break;
            default: throw new Error('未知参数：' + arg);
        }
    }
    return out;
}

function memoryStorage() {
    const data = new Map();
    return {
        getItem: key => data.has(key) ? data.get(key) : null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key),
    };
}

function createDocument() {
    const listeners = new Map();
    return {
        cookie: '', body: null, readyState: 'loading',
        querySelectorAll: () => [], getElementById: () => null,
        addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
        removeEventListener() {},
        createEvent() { return { initCustomEvent(type) { this.type = type; } }; },
        dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
    };
}

function detectImageType(buffer) {
    if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50
        && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.length >= 6) {
        const head = buffer.subarray(0, 6).toString('ascii');
        if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
    }
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return '';
}

function loadImage(file) {
    const buffer = fs.readFileSync(file);
    if (!buffer.length) throw new Error('图片为空');
    if (buffer.length > 10 * 1024 * 1024) throw new Error('图片超过 10 MiB');
    const type = detectImageType(buffer);
    if (!type) throw new Error('仅支持 PNG / JPEG / WebP / GIF');
    return { buffer, type };
}

class DebugFileReader {
    constructor() { this.result = null; this.onloadend = null; this.onerror = null; }
    readAsDataURL(blob) {
        blob.arrayBuffer().then(buffer => {
            this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
            this.onloadend?.();
        }, error => this.onerror?.(error));
    }
}

function redactHeaders(headers = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (/^authorization$/i.test(key)) {
            const token = String(value).replace(/^Bearer\s+/i, '');
            out[key] = `Bearer *** (${token.length} chars)`;
        } else out[key] = value;
    }
    return out;
}

function createHarness(image) {
    const exchanges = [];
    const window = {
        console, URL, URLSearchParams, Blob, ArrayBuffer, TextEncoder, TextDecoder, crypto: webcrypto,
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        btoa: value => Buffer.from(value, 'binary').toString('base64'),
        FileReader: DebugFileReader,
        setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
        navigator: {},
        location: new URL('https://pro.yuketang.cn/lesson/student/v3/debug'),
        document: createDocument(),
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
        addEventListener() {},
        request: { post: async () => ({ code: 0 }) },
        GM_xmlhttpRequest(options) {
            const controller = new AbortController();
            const started = Date.now();
            const timer = options.timeout ? setTimeout(() => controller.abort(), options.timeout) : null;
            const snapshot = {
                method: options.method || 'GET',
                url: options.url,
                headers: redactHeaders(options.headers || {}),
                body: options.data ?? null,
            };
            if (image && options.method === 'GET' && options.url === DEBUG_IMAGE_URL) {
                if (timer) clearTimeout(timer);
                const blob = new Blob([image.buffer], { type: image.type });
                setTimeout(() => {
                    exchanges.push({ ...snapshot, status: 200, finalUrl: options.url,
                        responseText: `[binary ${image.type}, ${image.buffer.length} bytes]`, elapsedMs: 0 });
                    options.onload?.({ status: 200, response: blob, finalUrl: options.url });
                }, 0);
                return { abort() {} };
            }
            fetch(options.url, {
                method: options.method || 'GET',
                headers: options.headers,
                body: options.data,
                redirect: 'follow',
                signal: controller.signal,
            }).then(async response => {
                if (timer) clearTimeout(timer);
                if (options.responseType === 'blob') {
                    const blob = await response.blob();
                    exchanges.push({ ...snapshot, status: response.status, finalUrl: response.url,
                        responseText: `[binary ${blob.type || 'unknown'}, ${blob.size} bytes]`, elapsedMs: Date.now() - started });
                    options.onload?.({ status: response.status, response: blob, finalUrl: response.url });
                    return;
                }
                const responseText = await response.text();
                exchanges.push({ ...snapshot, status: response.status, finalUrl: response.url, responseText, elapsedMs: Date.now() - started });
                options.onload?.({ status: response.status, responseText, finalUrl: response.url });
            }).catch(error => {
                if (timer) clearTimeout(timer);
                if (controller.signal.aborted) options.ontimeout?.();
                else options.onerror?.(error);
            });
            return { abort() { controller.abort(); } };
        },
    };
    window.window = window;
    window.self = window;
    window.top = window;
    vm.createContext(window);
    vm.runInContext(source.replace('    init();', `    window.api = {
        askQuizAI, parseAIAnswer, aiEndpoint, validateQuizSettings, QUIZ_DEFAULTS,
        settings: () => quizSettings,
    };`), window, { filename: sourcePath });
    return { api: window.api, exchanges };
}

function summarizeImageDataUrl(value) {
    const match = /^data:(image\/[^;]+);base64,(.*)$/i.exec(value);
    if (!match) return value.length > 200 ? value.slice(0, 200) + '…' : value;
    return `<${match[1]} data URL, ${match[2].length} base64 chars, omitted>`;
}

function prettyBody(value) {
    if (value == null) return String(value);
    let parsed;
    try { parsed = JSON.parse(value); } catch { return String(value); }
    if (Array.isArray(parsed?.messages)) {
        for (const message of parsed.messages) {
            if (!Array.isArray(message?.content)) continue;
            for (const part of message.content) {
                if (part?.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
                    part.image_url.url = summarizeImageDataUrl(part.image_url.url);
                }
            }
        }
    }
    return JSON.stringify(parsed, null, 2);
}

function printExchange(exchange) {
    if (!exchange) return;
    console.log('\n===== 请求 =====');
    console.log(exchange.method, exchange.url);
    console.log('Headers:', JSON.stringify(exchange.headers));
    console.log('Body:');
    console.log(prettyBody(exchange.body));
    console.log('\n===== 响应 =====');
    console.log('HTTP', exchange.status, `(${exchange.elapsedMs}ms)`);
    try {
        const data = JSON.parse(exchange.responseText);
        const message = data?.choices?.[0]?.message?.content;
        if (typeof message === 'string') {
            console.log('message.content:');
            console.log(message.slice(0, 20000));
        } else {
            console.log('原始响应:');
            console.log(String(exchange.responseText).slice(0, 20000));
        }
        if (data?.error) console.log('API error:', JSON.stringify(data.error));
    } catch {
        console.log('原始响应:');
        console.log(String(exchange.responseText).slice(0, 20000));
    }
}

async function main() {
    console.log(`rainclassroom-plugin@${version} debug:ai`);
    let args;
    try { args = parseArgs(process.argv.slice(2)); }
    catch (error) { console.error(error.message); console.error('\n' + usage()); process.exit(2); }
    if (args.help) { console.log(usage()); return; }
    args.apiKey = args.apiKey || process.env.RC_AI_API_KEY || '';
    const missing = [];
    if (!args.baseURL) missing.push('--base-url');
    if (!args.model) missing.push('--model');
    if (!args.question && !args.image) missing.push('--question 或 --image');
    if (!args.options.length) missing.push('--option');
    if (!args.apiKey) missing.push('RC_AI_API_KEY 或 --api-key');
    if (missing.length) { console.error('缺少：' + missing.join('、') + '\n\n' + usage()); process.exit(2); }
    if (![1, 2].includes(args.type)) { console.error('--type 只能是 1 或 2'); process.exit(2); }
    for (const option of args.options) {
        if (!/^[A-Z0-9]{1,8}$/.test(option.key)) {
            console.error('选项 key 必须为 1-8 位大写字母或数字：' + option.key);
            process.exit(2);
        }
    }

    let image = null;
    if (args.image) {
        try { image = loadImage(args.image); }
        catch (error) { console.error('图片读取失败：' + error.message); process.exit(2); }
    }

    const { api, exchanges } = createHarness(image);
    let settings;
    try {
        settings = api.validateQuizSettings({
            ...api.QUIZ_DEFAULTS, enabled: true, mode: 'ai-display', delay: 3, timeout: args.timeout, safety: 3,
            baseURL: args.baseURL, model: args.model, apiKey: args.apiKey, images: Boolean(image),
        });
    } catch (error) { console.error('配置无效：' + error.message); process.exit(2); }

    const question = { id: 'debug-question', lesson: 'debug-lesson', type: args.type, body: args.question || '',
        options: args.options, image: image ? DEBUG_IMAGE_URL : '' };
    const job = { cancelled: false, settings, requests: new Set(), started: Date.now(), timer: null };
    console.log('Endpoint:', api.aiEndpoint(settings.baseURL));
    console.log('Model:', settings.model);
    console.log('Question:', question.body ? JSON.stringify({ question: question.body, type: question.type === 2 ? '多选' : '单选', options: question.options }) : '(仅图片)');
    if (image) console.log('Image:', `${args.image} (${image.type}, ${image.buffer.length} bytes)`);

    const started = Date.now();
    let answer;
    try {
        answer = await api.askQuizAI(question, job);
    } catch (error) {
        printExchange(exchanges.at(-1));
        console.error(`\nAI 回答失败（${Date.now() - started}ms）：` + error.message);
        process.exitCode = 1;
        return;
    }
    printExchange(exchanges.at(-1));
    console.log(`\n===== 解析结果（${Date.now() - started}ms）=====`);
    console.log('answer:', answer.choices.join(', '));
    console.log('explanation:', answer.explanation || '(空)');
}

main().catch(error => { console.error(error); process.exit(1); });
