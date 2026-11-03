import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'
import { contrast, resolve } from './palette-helpers.mjs'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)[1]

for (const [name, saved] of [['first visit', null], ['saved light', 'light'], ['invalid preference', 'invalid'], ['saved dark', 'dark'], ['blocked storage', new Error('blocked')]]) {
  test(`pre-paint theme: ${name}`, () => {
    const root = { dataset: {}, style: {} }
    const meta = { content: '#2563EB' }
    runInNewContext(bootstrap, {
      document: { documentElement: root, querySelector: () => meta },
      localStorage: { getItem: () => { if (saved instanceof Error) throw saved; return saved } },
    })
    assert.equal(root.dataset.theme, saved === 'dark' ? 'dark' : undefined)
    assert.equal(meta.content, saved === 'dark' ? '#0B1736' : '#2563EB')
  })
}

for (const theme of ['light', 'dark']) {
  const pairs = [
    ['text', 'bg'], ['text', 'surface'], ['text-secondary', 'bg'], ['text-secondary', 'surface'],
    ['text-on-soft', 'soft'], ['text-on-soft', 'raised'], ['link', 'soft'], ['link', 'surface'],
    ['on-primary', 'primary'], ['on-primary', 'primary-hover'],
    ['banner-text', 'banner-bg'], ['banner-muted', 'banner-bg'],
    ['success-text', 'success-bg'], ['error-text', 'error-bg'], ['warning-text', 'warning-bg'],
  ]
  for (const [foreground, background] of pairs) test(`${theme} ${foreground} on ${background} meets WCAG AA`, () => {
    assert.ok(contrast(`var(--${foreground})`, `var(--${background})`, theme) >= 4.5, `${foreground} on ${background}`)
  })
  for (const surface of ['bg', 'surface', 'raised']) test(`${theme} focus and input borders remain visible on ${surface}`, () => {
    assert.ok(contrast('var(--focus)', `var(--${surface})`, theme) >= 3)
    assert.ok(contrast('var(--control-border)', `var(--${surface})`, theme) >= 3)
  })
}
test('brand tokens match the requested blue palette', () => {
  for (const [name, hex] of Object.entries({ primary: '#2563EB', 'primary-hover': '#1D4ED8', 'deep-navy': '#0B1736', 'light-blue': '#DBEAFE', accent: '#60A5FA', bg: '#F8FAFC', surface: '#FFFFFF', text: '#0F172A', 'text-secondary': '#64748B' })) {
    assert.equal(resolve(`var(--${name})`), hex)
  }
})
