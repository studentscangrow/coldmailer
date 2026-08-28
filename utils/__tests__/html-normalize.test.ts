// @vitest-environment jsdom
// dompurify needs a real DOM (window) to sanitize anything — under the default node
// environment it silently no-ops and returns input unchanged, which made every test here
// pass a value through unsanitized instead of exercising sanitizeHtml at all.
import { describe, it, expect } from 'vitest'
import { sanitizeHtml, normalizeHtml, sanitizeAndNormalizeHtml } from '../html-normalize'

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

describe('sanitizeHtml', () => {
  it('removes script tags', () => {
    expect(sanitizeHtml('<p>Hello<script>alert(1)</script></p>'))
      .toBe('<p>Hello</p>')
  })

  it('removes event handlers', () => {
    expect(sanitizeHtml('<p onclick="alert(1)">Hello</p>'))
      .toBe('<p>Hello</p>')
  })

  it('removes dangerous href protocols', () => {
    const result = sanitizeHtml('<a href="javascript:alert(1)">Click</a>')
    expect(result).not.toContain('javascript:')
    // The link may be kept without href, or the <a> tag removed — either is safe
    expect(result).toContain('Click')
  })

  it('preserves safe links and adds rel on target=_blank', () => {
    const input = '<a href="https://tourdeapp.cz" target="_blank">tourdeapp.cz</a>'
    const result = sanitizeHtml(input)
    expect(result).toContain('href="https://tourdeapp.cz"')
    expect(result).toContain('target="_blank"')
    expect(result).toContain('rel="noopener noreferrer"')
  })

  it('removes unsafe style properties', () => {
    const input = '<span style="color: red; position: fixed; background-image: url(javascript:alert(1));">Text</span>'
    const result = sanitizeHtml(input)
    expect(result).toContain('color')
    expect(result).not.toContain('position')
    expect(result).not.toContain('background-image')
    expect(result).toContain('Text')
  })

  it('removes iframe tags', () => {
    expect(sanitizeHtml('<p>Before</p><iframe src="//evil.com"></iframe><p>After</p>'))
      .toBe('<p>Before</p><p>After</p>')
  })

  it('removes object/embed tags', () => {
    expect(sanitizeHtml('<object data="x"></object><embed src="x">')).toBe('')
  })

  it('removes form elements', () => {
    const result = sanitizeHtml('<form><input type="text"><button>Go</button></form>')
    expect(result).not.toContain('<form')
    expect(result).not.toContain('<input')
    expect(result).not.toContain('<button')
  })

  it('removes data: protocol from href', () => {
    const result = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    expect(result).not.toContain('data:')
  })

  it('removes style expression() values', () => {
    const result = sanitizeHtml('<span style="width: expression(alert(1));">Text</span>')
    expect(result).not.toContain('expression')
  })

  it('keeps allowed tags and attributes', () => {
    const input = '<p><strong>Bold</strong> <em>Italic</em> <u>Underline</u></p>'
    expect(sanitizeHtml(input)).toBe(input)
  })

  it('removes svg tags', () => {
    const result = sanitizeHtml('<p>Text</p><svg onload="alert(1)"><circle></circle></svg>')
    expect(result).not.toContain('svg')
  })

  it('removes on* attributes from any element', () => {
    const result = sanitizeHtml('<div onmouseover="alert(1)">Hello</div>')
    expect(result).not.toContain('onmouseover')
  })
})

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe('normalizeHtml', () => {
  it('removes redundant inherited font-family', () => {
    const input = '<div style="font-family: &quot;Inter Tight&quot;;"><p><span style="font-family: &quot;Inter Tight&quot;;">Text</span></p></div>'
    const result = normalizeHtml(input)
    // The font-family should appear once (on the wrapper), not on the inner span
    expect(result).toContain('font-family')
    // Span should be removed (no style left → useless span)
    expect(result).not.toMatch(/<span[^>]*font-family[^>]*>Text<\/span>/)
    expect(result).toContain('Text')
  })

  it('merges adjacent spans with identical styles', () => {
    const input = '<p><span style="color: rgb(239, 138, 23);">Hello</span><span style="color: rgb(239, 138, 23);"> world</span></p>'
    const result = normalizeHtml(input)
    expect(result).toContain('Hello world')
    // Should be a single span, not two
    const spanCount = (result.match(/<span/g) ?? []).length
    expect(spanCount).toBe(1)
  })

  it('normalises empty styled paragraphs', () => {
    const input = '<p><span style="font-family: &quot;Inter Tight&quot;;"><strong><br></strong></span></p>'
    const result = normalizeHtml(input)
    // Empty paragraph — all wrappers removed, only <p><br></p> remains (possibly inside a hoisted wrapper)
    expect(result).toContain('<p><br></p>')
    expect(result).not.toContain('<strong>')
    expect(result).not.toContain('<span')
  })

  it('keeps visually meaningful colour differences', () => {
    const input = '<div style="font-family: &quot;Inter Tight&quot;;"><p><span style="color: rgb(239, 138, 23);">Orange</span> Normal</p></div>'
    const result = normalizeHtml(input)
    // The colour span must remain because it adds a visible difference
    expect(result).toContain('color: rgb(239, 138, 23)')
    expect(result).toContain('Orange')
  })

  it('preserves basic rich text formatting', () => {
    const input = '<p><strong>Bold</strong> <em>Italic</em> <u>Underline</u></p>'
    const result = normalizeHtml(input)
    expect(result).toContain('<strong>Bold</strong>')
    expect(result).toContain('<em>Italic</em>')
    expect(result).toContain('<u>Underline</u>')
  })

  it('removes empty/useless spans', () => {
    const result = normalizeHtml('<p><span>Text</span></p>')
    expect(result).toBe('<p>Text</p>')
  })

  it('removes style="" empty attributes', () => {
    const result = normalizeHtml('<p style="">Hello</p>')
    expect(result).toBe('<p>Hello</p>')
  })

  it('moves trailing <br> out of formatting wrappers', () => {
    const result = normalizeHtml('<p><strong>Name<br></strong></p>')
    expect(result).toBe('<p><strong>Name</strong><br></p>')
  })

  it('unwraps <br> that is sole child of formatting tag', () => {
    const result = normalizeHtml('<p><strong><br></strong></p>')
    expect(result).toBe('<p><br></p>')
  })

  it('normalises colour formats to rgb()', () => {
    const result = normalizeHtml('<span style="color: #EF8A17;">Text</span>')
    expect(result).toContain('color: rgb(239, 138, 23)')
  })

  it('normalises rgb spacing', () => {
    const result = normalizeHtml('<span style="color: rgb(239,138,23);">Text</span>')
    expect(result).toContain('color: rgb(239, 138, 23)')
  })

  it('normalises font-family quoting', () => {
    // Two different fonts so hoisting doesn't collapse everything
    const result = normalizeHtml('<p><span style="font-family: \'Inter Tight\';">Text</span></p><p><span style="font-family: Arial;">Other</span></p>')
    // Inter Tight should be quoted (multi-word) — HTML attribute uses &quot;
    expect(result).toMatch(/Inter Tight/)
  })

  it('serialises style properties in consistent order', () => {
    // Use properties that won't trigger font hoisting
    const input = '<span style="color: red; font-size: 14px; font-weight: bold;">Text</span>'
    const result = normalizeHtml(input)
    const styleMatch = result.match(/style="([^"]*)"/)
    expect(styleMatch).toBeTruthy()
    const style = styleMatch![1]
    const sizeIdx = style.indexOf('font-size')
    const weightIdx = style.indexOf('font-weight')
    const colorIdx = style.indexOf('color')
    // Order: font-size < font-weight < color
    expect(sizeIdx).toBeLessThan(weightIdx)
    expect(weightIdx).toBeLessThan(colorIdx)
  })

  it('does not merge spans with different styles', () => {
    const input = '<p><span style="color: rgb(255, 0, 0);">Red</span><span style="color: rgb(0, 0, 255);">Blue</span></p>'
    const result = normalizeHtml(input)
    expect(result).toContain('Red')
    expect(result).toContain('Blue')
    const spanCount = (result.match(/<span/g) ?? []).length
    expect(spanCount).toBe(2)
  })

  it('hoists common font-family to wrapper div', () => {
    const input = '<p><span style="font-family: &quot;Inter Tight&quot;;">Hello</span></p><p><span style="font-family: &quot;Inter Tight&quot;;">World</span></p>'
    const result = normalizeHtml(input)
    // Should have a wrapper div with font-family
    expect(result).toMatch(/^<div style="[^"]*font-family[^"]*">/)
    // Inner spans should be removed (became useless after font removal)
    expect(result).not.toMatch(/<span[^>]*font-family/)
  })

  it('keeps differing font-family when mixed', () => {
    const input = '<p><span style="font-family: Arial;">First</span></p><p><span style="font-family: Georgia;">Second</span></p>'
    const result = normalizeHtml(input)
    // Both fonts should survive somewhere
    expect(result).toContain('Arial')
    expect(result).toContain('Georgia')
  })

  it('normalises links with www prefix to https', () => {
    const result = normalizeHtml('<a href="www.example.com">Link</a>')
    expect(result).toContain('href="https://www.example.com"')
  })
})

// ---------------------------------------------------------------------------
// Combined pipeline
// ---------------------------------------------------------------------------

describe('sanitizeAndNormalizeHtml', () => {
  it('sanitises then normalises', () => {
    const input = '<p onclick="alert(1)"><span style="font-family: Arial; position: fixed;">Text<script>x</script></span></p>'
    const result = sanitizeAndNormalizeHtml(input)
    expect(result).not.toContain('script')
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('position')
    expect(result).toContain('Text')
  })

  it('returns empty string for blank input', () => {
    expect(sanitizeAndNormalizeHtml('')).toBe('')
    expect(sanitizeAndNormalizeHtml('   ')).toBe('')
  })

  it('can skip sanitisation', () => {
    const input = '<p>Hello</p>'
    expect(sanitizeAndNormalizeHtml(input, { sanitize: false })).toContain('Hello')
  })

  it('can skip normalisation', () => {
    const input = '<p><span>Text</span></p>'
    const result = sanitizeAndNormalizeHtml(input, { normalize: false })
    // Without normalisation, useless span should remain
    expect(result).toContain('<span>')
  })
})
