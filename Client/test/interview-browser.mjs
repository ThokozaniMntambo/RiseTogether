// Optional real-browser UI checks. Run Vite first, then:
// node test/interview-browser.mjs
// CHROME_PATH can select another installed Chromium binary. All API/audio are mocked.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import assert from 'node:assert/strict'

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
const executable = candidates.find(path => path && existsSync(path))
if (!executable) throw new Error('Set CHROME_PATH to an installed Chrome/Chromium browser.')
const artifacts = resolvePath('node_modules/.tmp/interview-ui')
mkdirSync(artifacts, { recursive: true })
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${resolvePath(`node_modules/.tmp/interview-browser-${process.pid}`)}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let socket
const pending = new Map(), handlers = new Set()
let nextId = 0, sessionId
function command(method, params = {}, target = sessionId) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 10000)
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
const click = label => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(label)}); button.click(); })()`)
const fill = (id, value) => evaluate(`(() => { const input = document.getElementById(${JSON.stringify(id)}); const setter = Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)

const questions = ['Why does this role interest you?', 'Describe a project you completed.', 'How do you solve a difficult problem?', 'How do you handle feedback?', 'What would you learn in your first month?']
const evaluation = { overallScore: 70, answers: questions.map((_, index) => ({ questionNumber: index + 1, score: 70, feedback: 'Use a specific example and explain the outcome.' })), strengths: ['Relevant examples'], improvements: ['Explain outcomes'], recommendations: ['Practise a structured answer.'] }
let questionCalls = 0, evaluationCalls = 0, denyEvaluation = false
const failures = []
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
  handlers.add(message => {
    if (message.method === 'Runtime.exceptionThrown') failures.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
    if (message.method !== 'Fetch.requestPaused') return
    const request = message.params
    const path = new URL(request.request.url).pathname
    let status = 200, data
    if (path === '/api/auth/me') data = { user: { id: '507f1f77bcf86cd799439011', name: 'Demo Student', email: 'demo@example.com' } }
    else if (path.endsWith('/interview-coach/questions')) { questionCalls++; data = { questions, interviewToken: 'mock-signed-token' } }
    else if (path.endsWith('/realtime/sessions')) data = { id: 'browser-mock', sdp: 'v=0 mock', expiresAt: Date.now() + 600000 }
    else if (path.endsWith('/heartbeat')) data = { ended: false }
    else if (path.endsWith('/end')) data = { ended: true }
    else if (path.endsWith('/feedback')) data = { evaluation: null, incomplete: true, transcript: [], message: 'Not enough evidence to score.' }
    else if (path.endsWith('/interview-coach/evaluate')) {
      evaluationCalls++
      const body = JSON.parse(request.request.postData)
      assert.equal(body.answers.length, 5); assert.ok(body.answers.every(answer => answer.trim()))
      if (denyEvaluation) { status = 429; data = { message: 'Shared AI allowance exhausted. Your answers are kept.' } } else data = { evaluation }
    } else { status = 404; data = { message: 'Unexpected test API request' } }
    command('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(data)).toString('base64') }).catch(error => failures.push(String(error)))
  })
  await command('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] })
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__audio = { starts: 0, stopped: 0, spoken: 0 };
    const unsupported = new URL(location.href).searchParams.has('unsupported');
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => {
      window.__audio.starts++;
      const track = { enabled: true, stop: () => window.__audio.stopped++, onended: null };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } });
    class Peer {
      addTrack() {}
      createDataChannel() { this.channel = { readyState: 'open', send: data => {
        if (JSON.parse(data).type === 'response.create') { window.__audio.spoken++; this.channel.onmessage({ data: JSON.stringify({ type: 'response.output_audio_transcript.done', item_id: 'hello', transcript: 'Hello! I am Alex. How are you feeling today?' }) }); }
      }, close() {} }; window.__channel = this.channel; return this.channel; }
      async createOffer() { return { type: 'offer', sdp: 'v=0 mock-offer' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription() { this.channel.onopen(); }
      close() { window.__closed = true; }
    }
    Object.defineProperty(window, 'RTCPeerConnection', { value: unsupported ? undefined : Peer });
  ` })

  for (const scenario of [{ theme: 'light', mode: 'text' }, { theme: 'dark', mode: 'text', quota: true }, { theme: 'dark', mode: 'voice' }, { theme: 'light', mode: 'unsupported' }]) {
    await command('Emulation.setDeviceMetricsOverride', { width: scenario.theme === 'dark' ? 390 : 1280, height: 950, deviceScaleFactor: 1, mobile: scenario.theme === 'dark' })
    await load('Page.navigate', { url: `http://127.0.0.1:5173/dashboard/interview-coach${scenario.mode === 'unsupported' ? '?unsupported' : ''}` })
    await until(`Boolean(document.getElementById('interview-job'))`)
    await evaluate(`localStorage.setItem('risetogether-theme', '${scenario.theme}')`)
    await load('Page.reload')
    await until(`Boolean(document.getElementById('interview-job'))`)
    assert.equal(await evaluate(`document.documentElement.dataset.theme === 'dark'`), scenario.theme === 'dark')
    await fill('interview-job', 'Junior developer'); await fill('interview-company', 'Example Company')
    if (scenario.mode !== 'text') await evaluate(`document.querySelectorAll('input[type=radio]')[1].click()`)
    assert.equal(await evaluate('window.__audio.starts'), 0)
    await click('Start interview')
    if (scenario.mode !== 'text') {
      await until("Boolean(document.querySelector('.live-interview'))")
      assert.equal(await evaluate("Boolean(document.getElementById('interview-answer'))"), false)
      assert.equal(await evaluate("/Start Recording|Stop Recording|Replay Question|Submit answer/.test(document.body.innerText)"), false)
      if (scenario.mode === 'unsupported') {
        await until("document.body.innerText.includes('cannot run a live audio interview')")
        assert.equal(await evaluate('window.__audio.starts'), 0)
      } else {
        await until("document.body.innerText.includes('How are you feeling today?')")
        assert.equal(await evaluate('window.__audio.starts'), 1)
        assert.equal(await evaluate('window.__audio.spoken'), 1)
        await click('Mute microphone'); await click('Unmute microphone')
        await click('Mute speaker'); await click('Unmute speaker')
        await click('End Interview')
        await until("document.body.innerText.includes('Not enough evidence to score.')")
        assert.ok(await evaluate('window.__audio.stopped > 0 && window.__closed'))
      }
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      writeFileSync(resolvePath(artifacts, scenario.mode + '.png'), Buffer.from(screenshot.data, 'base64'))
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
      await click('Return to setup / Text Mode')
      await until("Boolean(document.getElementById('interview-job'))")
      console.log('PASS browser UI (mock audio): ' + scenario.mode)
      continue
    }
    await until(`document.body.innerText.includes('Question 1 of 5')`)
    assert.equal(await evaluate('window.__audio.starts'), 0)
    assert.equal(await evaluate(`document.querySelector('button[type=submit]')?.disabled ?? [...document.querySelectorAll('button')].find(item => item.textContent.includes('Submit answer')).disabled`), true)
    const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(resolvePath(artifacts, `${scenario.theme}-${scenario.mode}.png`), Buffer.from(screenshot.data, 'base64'))
    for (let i = 0; i < 5; i++) {
      await until(`document.body.innerText.includes('Question ${i + 1} of 5')`)
      await fill('interview-answer', `Corrected answer ${i + 1}: I built a project and tested the result.`)
      denyEvaluation = Boolean(scenario.quota)
      await click(i === 4 ? 'Submit & get feedback' : 'Submit answer')
    }
    if (scenario.quota) {
      await until(`document.body.innerText.includes('Shared AI allowance exhausted')`)
      assert.ok((await evaluate('document.body.innerText')).includes('Corrected answer 5'))
      denyEvaluation = false; await click('Retry evaluation')
    }
    await until(`document.body.innerText.includes('Your interview feedback')`)
    assert.equal(await evaluate(`document.querySelectorAll('.interview-answer-review article').length`), 5)
    assert.ok((await evaluate('document.body.innerText')).includes('Overall score'))
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
    console.log(`PASS browser UI: ${scenario.theme}, ${scenario.mode}${scenario.quota ? ', quota retry' : ''}`)
  }
  assert.equal(questionCalls, 2); assert.equal(evaluationCalls, 3); assert.deepEqual(failures, [])
  console.log(`PASS: text interviews and live voice UI (mock audio). Screenshots: ${artifacts}`)
} finally {
  if (socket?.readyState === WebSocket.OPEN) await command('Browser.close', {}, null).catch(() => {})
  socket?.close(); browser.kill()
}
