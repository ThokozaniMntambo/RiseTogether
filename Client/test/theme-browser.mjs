// Theme-only browser checks. Run Vite first, then:
// node test/theme-browser.mjs
// CHROME_PATH can select another installed Chromium binary. Authentication API responses are mocked; no provider calls.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import assert from 'node:assert/strict'

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
const executable = candidates.find(path => path && existsSync(path))
if (!executable) throw new Error('Set CHROME_PATH to an installed Chrome/Chromium browser.')
const artifacts = resolvePath('node_modules/.tmp/theme-ui')
mkdirSync(artifacts, { recursive: true })
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${resolvePath(`node_modules/.tmp/theme-browser-${process.pid}`)}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let socket
const pending = new Map(), handlers = new Set()
let nextId = 0, sessionId
function command(method, params = {}, target = sessionId) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    socket.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }))
  })
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description)
  return result.result.value
}
async function until(expression) {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 70)) }
  throw new Error(`UI condition timed out: ${expression}\n${await evaluate('document.body.innerText')}`)
}
async function load(method, params = {}) {
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { handlers.delete(handler); reject(new Error('Page load timed out')) }, 30000)
    const handler = message => { if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) { clearTimeout(timer); handlers.delete(handler); resolve() } }
    handlers.add(handler)
  })
  await command(method, params)
  await loaded
}

try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Headless browser did not start.')), 10000)
    browser.on('error', error => { clearTimeout(timer); reject(error) })
    browser.stderr.on('data', data => { output += String(data); writeFileSync(resolvePath(artifacts, 'browser-stderr.log'), output); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) { const entry = pending.get(message.id); pending.delete(message.id); if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result); return }
    for (const handler of handlers) handler(message)
  })
  const target = await command('Target.createTarget', { url: 'about:blank' }, null)
  sessionId = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId
  await command('Page.enable'); await command('Runtime.enable')
  let signedIn = true
  const failures = []
  const contrastFailures = []
  handlers.add(message => {
    if (message.method === 'Runtime.exceptionThrown') failures.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
    if (message.method !== 'Fetch.requestPaused') return
    const request = message.params
    const path = new URL(request.request.url).pathname
    const data = path === '/api/auth/me' && signedIn ? { user: { id: '507f1f77bcf86cd799439011', name: 'Demo Student', email: 'demo@example.com' } } : { message: 'Not signed in' }
    command('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: signedIn ? 200 : 401, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(data)).toString('base64') }).catch(e => failures.push(String(e)))
  })
  await command('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] })
  const pages = [
    ['home', '/', '.hero'], ['login', '/login', '.auth-form'], ['register', '/register', '.auth-form'],
    ['dashboard', '/dashboard', '.welcome-banner'], ['career', '/dashboard/career-coach', '.career-chat'],
    ['cv', '/dashboard/cv-coach', '.cv-form'], ['interview', '/dashboard/interview-coach', '#interview-job'],
    ['roadmap', '/dashboard/learning-roadmap', '.coming-soon'], ['analytics', '/dashboard/career-analytics', '.coming-soon'],
  ]
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 })
    for (const [name, path, selector] of pages) {
      signedIn = !['login', 'register', 'home'].includes(name)
      await load('Page.navigate', { url: 'http://127.0.0.1:5173' + path })
      await evaluate(`localStorage.setItem('risetogether-theme', '${theme}')`)
      await load('Page.reload')
      await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
      assert.equal(await evaluate(`document.documentElement.dataset.theme === 'dark'`), theme === 'dark')
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${theme}/${width}/${name} overflows`)
      const colours = await evaluate(`(() => {
        const s = getComputedStyle(document.documentElement);
        return { primary: s.getPropertyValue('--primary').trim(), background: s.backgroundColor, font: s.fontFamily };
      })()`)
      assert.ok(colours.font.includes('Segoe UI'), `${name}: typography changed to ${colours.font}`)
      const fonts = await evaluate(`['body', 'h1', 'p', 'button'].map(selector => { const node = document.querySelector(selector); return node ? [selector, getComputedStyle(node).fontFamily] : null; }).filter(Boolean)`)
      for (const [element, font] of fonts) assert.ok(font.includes('Segoe UI'), `${name}/${element}: typography changed to ${font}`)
      assert.equal(colours.background, theme === 'dark' ? 'rgb(11, 23, 54)' : 'rgb(248, 250, 252)')
      const unreadable = await evaluate(`(() => {
        const rgb = value => (value.match(/[\\d.]+/g) || []).map(Number);
        const blend = (a, b) => a.slice(0, 3).map((c, i) => c * (a[3] ?? 1) + b[i] * (1 - (a[3] ?? 1)));
        const luminance = a => a.map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0);
        return [...document.querySelectorAll('body *')].filter(node => node.childNodes.length && [...node.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) && node.getBoundingClientRect().width > 0 && !node.closest('svg') && !node.disabled).flatMap(node => {
          const style = getComputedStyle(node);
          if (style.visibility === 'hidden') return [];
          const ancestors = []; for (let p = node; p; p = p.parentElement) ancestors.unshift(p);
          const background = ancestors.reduce((bg, p) => blend(rgb(getComputedStyle(p).backgroundColor), bg), [255, 255, 255]);
          const foreground = blend(rgb(style.color), background);
          const a = luminance(foreground), b = luminance(background);
          const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
          const required = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
          return ratio + .01 < required ? [{ text: node.textContent.trim().slice(0, 65), class: node.className, ratio: ratio.toFixed(2) }] : [];
        });
      })()`)
      if (unreadable.length) contrastFailures.push({ theme, width, name, unreadable })
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      writeFileSync(resolvePath(artifacts, `${theme}-${width}-${name}.png`), Buffer.from(screenshot.data, 'base64'))
      console.log(`PASS ${theme} / ${width}px / ${name}`)
    }
  }
  assert.deepEqual(failures, [])
  assert.deepEqual(contrastFailures, [], 'Rendered text must meet WCAG AA')
  console.log('PASS all 36 theme/page/viewport checks. Screenshots: ' + artifacts)
} finally {
  if (socket?.readyState === WebSocket.OPEN) await command('Browser.close', {}, null).catch(() => {})
  socket?.close(); browser.kill()
}
