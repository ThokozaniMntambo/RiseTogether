import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { contrast } from './palette-helpers.mjs'

const css = readFileSync(new URL('../src/InterviewCoach.css', import.meta.url), 'utf8')
const globalCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
function declaration(source, selector, property) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = source.match(new RegExp(`(?:^|})\\s*${escaped}\\{([^}]*)\\}`))?.[1]
  assert.ok(body, `Missing rule: ${selector}`)
  const value = body.match(new RegExp(`(?:^|;)${property}:([^;]+)`))?.[1]
  assert.ok(value, `Missing ${property} in ${selector}`)
  return value
}
function readable(foreground, background, theme = 'light') {
  assert.ok(contrast(foreground, background, theme) >= 4.5, `${foreground} on ${background} must meet AA`)
}

test('light interview panel text, labels, hints and inputs meet AA contrast', () => {
  const panel = declaration(css, '.interview-panel', 'background')
  readable(declaration(globalCss, ':root', 'color'), panel)
  readable(declaration(globalCss, 'p', 'color'), panel)
  readable(declaration(css, '.interview-panel label,.interview-panel legend', 'color'), panel)
  readable(declaration(css, '.interview-progress', 'color'), panel)
  readable(declaration(css, '.interview-privacy p', 'color'), declaration(css, '.interview-privacy', 'background'))
  const field = '.interview-panel :is(input:not([type=radio]),select,textarea)'
  readable(declaration(css, field, 'color'), declaration(css, field, 'background'))
  readable(declaration(css, '.interview-panel :is(input,textarea)::placeholder', 'color'), declaration(css, field, 'background'))
})
test('dark interview cards, fields and voice controls use the accessible shared palette', () => {
    const surface = declaration(css, '[data-theme="dark"] .interview-panel', 'background')
  assert.equal(surface, 'var(--surface)')
  const field = '[data-theme="dark"] .interview-panel :is(input:not([type=radio]),select,textarea)'
  assert.equal(declaration(css, field, 'background'), 'var(--bg)')
  assert.equal(declaration(css, field, 'color'), 'var(--text)')
  for (const foreground of ['text', 'highlight', 'text-secondary']) for (const background of ['surface', 'bg', 'sidebar']) readable(`var(--${foreground})`, `var(--${background})`, 'dark')
})
