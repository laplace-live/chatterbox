import { describe, expect, test } from 'bun:test'

import { Md5 } from './md5'

/** Source-of-truth MD5 via Bun's native hasher; verifies our impl on multi-byte UTF-8, not just ASCII. */
function referenceMd5(str: string): string {
  return new Bun.CryptoHasher('md5').update(str).digest('hex')
}

const inputs: { label: string; value: string }[] = [
  { label: 'empty string', value: '' },
  { label: 'ascii word', value: 'hello' },
  { label: 'ascii sentence', value: 'The quick brown fox jumps over the lazy dog' },
  { label: 'digits', value: '123456' },
  { label: 'email', value: 'test@example.com' },
  { label: 'ascii with punctuation', value: 'Hello World!' },
  { label: 'multibyte: 中文 + ascii', value: 'LAPLACE 弹幕助手' },
  { label: 'multibyte: all 中文', value: '哔哩哔哩直播间' },
  { label: 'long ascii (100 chars)', value: 'a'.repeat(100) },
  { label: 'mixed 中英文 + digits', value: 'Mixed 中英文 Text 123' },
  { label: 'special chars', value: 'special!@#$%^&*()chars' },
  { label: 'whitespace control chars', value: '\n\t\r' },
  { label: 'json', value: '{"key": "value"}' },
  { label: 'url', value: 'https://live.bilibili.com/12345' },
]

describe('Md5.hashStr', () => {
  test.each(inputs)('matches reference MD5 for $label', ({ value }) => {
    expect(Md5.hashStr(value)).toBe(referenceMd5(value))
  })
})
