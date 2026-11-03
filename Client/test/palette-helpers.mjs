import { readFileSync } from 'node:fs'
const css = readFileSync(new URL('../src/palette.css', import.meta.url), 'utf8')
function declarations(body) { return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()])) }
const light = declarations(css.match(/:root\s*\{([^}]+)\}/)[1])
const dark = { ...light, ...declarations(css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/)[1]) }
export function resolve(value, theme = 'light') {
  const tokens = theme === 'dark' ? dark : light
  return value.replace(/var\((--[\w-]+)\)/g, (_, key) => { if (!tokens[key]) throw new Error(`Unknown theme token ${key}`); return resolve(tokens[key], theme) })
}
export function luminance(hex) {
  let value = hex.trim().replace('#', '')
  if (value.length === 3) value = [...value].map(c => c + c).join('')
  const rgb = value.match(/../g).slice(0, 3).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4)
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
}
export function contrast(a, b, theme = 'light') {
  const x = luminance(resolve(a, theme)), y = luminance(resolve(b, theme))
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}
