export function md5(str: string): string {
  function rotateLeft(n: number, s: number) {
    return (n << s) | (n >>> (32 - s))
  }

  function addUnsigned(x: number, y: number) {
    const lsw = (x & 0xffff) + (y & 0xffff)
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16)
    return (msw << 16) | (lsw & 0xffff)
  }

  function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
    return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, q), addUnsigned(x, t)), s), b)
  }

  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & c) | (~b & d), a, b, x, s, t)
  }

  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t)
  }

  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(b ^ c ^ d, a, b, x, s, t)
  }

  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(c ^ (b | ~d), a, b, x, s, t)
  }

  /** Reads a word from the array, treating sparse (undefined) positions as 0. */
  function w(arr: number[], idx: number): number {
    return arr[idx] ?? 0
  }

  function convertToWordArray(s: string): number[] {
    const wordArray: number[] = []
    for (let i = 0; i < s.length * 8; i += 8) {
      const idx = i >> 5
      wordArray[idx] = w(wordArray, idx) | ((s.charCodeAt(i / 8) & 0xff) << (i % 32))
    }
    return wordArray
  }

  function wordToHex(value: number): string {
    let hex = ''
    for (let i = 0; i < 4; i++) {
      hex += ((value >> (i * 8 + 4)) & 0x0f).toString(16) + ((value >> (i * 8)) & 0x0f).toString(16)
    }
    return hex
  }

  const x = convertToWordArray(str)
  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476

  const padIdx = str.length >> 2
  x[padIdx] = w(x, padIdx) | (0x80 << ((str.length % 4) * 8))
  x[(((str.length + 8) >> 6) << 4) + 14] = str.length * 8

  for (let i = 0; i < x.length; i += 16) {
    const oldA = a
    const oldB = b
    const oldC = c
    const oldD = d

    a = ff(a, b, c, d, w(x, i + 0), 7, 0xd76aa478)
    d = ff(d, a, b, c, w(x, i + 1), 12, 0xe8c7b756)
    c = ff(c, d, a, b, w(x, i + 2), 17, 0x242070db)
    b = ff(b, c, d, a, w(x, i + 3), 22, 0xc1bdceee)
    a = ff(a, b, c, d, w(x, i + 4), 7, 0xf57c0faf)
    d = ff(d, a, b, c, w(x, i + 5), 12, 0x4787c62a)
    c = ff(c, d, a, b, w(x, i + 6), 17, 0xa8304613)
    b = ff(b, c, d, a, w(x, i + 7), 22, 0xfd469501)
    a = ff(a, b, c, d, w(x, i + 8), 7, 0x698098d8)
    d = ff(d, a, b, c, w(x, i + 9), 12, 0x8b44f7af)
    c = ff(c, d, a, b, w(x, i + 10), 17, 0xffff5bb1)
    b = ff(b, c, d, a, w(x, i + 11), 22, 0x895cd7be)
    a = ff(a, b, c, d, w(x, i + 12), 7, 0x6b901122)
    d = ff(d, a, b, c, w(x, i + 13), 12, 0xfd987193)
    c = ff(c, d, a, b, w(x, i + 14), 17, 0xa679438e)
    b = ff(b, c, d, a, w(x, i + 15), 22, 0x49b40821)

    a = gg(a, b, c, d, w(x, i + 1), 5, 0xf61e2562)
    d = gg(d, a, b, c, w(x, i + 6), 9, 0xc040b340)
    c = gg(c, d, a, b, w(x, i + 11), 14, 0x265e5a51)
    b = gg(b, c, d, a, w(x, i + 0), 20, 0xe9b6c7aa)
    a = gg(a, b, c, d, w(x, i + 5), 5, 0xd62f105d)
    d = gg(d, a, b, c, w(x, i + 10), 9, 0x02441453)
    c = gg(c, d, a, b, w(x, i + 15), 14, 0xd8a1e681)
    b = gg(b, c, d, a, w(x, i + 4), 20, 0xe7d3fbc8)
    a = gg(a, b, c, d, w(x, i + 9), 5, 0x21e1cde6)
    d = gg(d, a, b, c, w(x, i + 14), 9, 0xc33707d6)
    c = gg(c, d, a, b, w(x, i + 3), 14, 0xf4d50d87)
    b = gg(b, c, d, a, w(x, i + 8), 20, 0x455a14ed)
    a = gg(a, b, c, d, w(x, i + 13), 5, 0xa9e3e905)
    d = gg(d, a, b, c, w(x, i + 2), 9, 0xfcefa3f8)
    c = gg(c, d, a, b, w(x, i + 7), 14, 0x676f02d9)
    b = gg(b, c, d, a, w(x, i + 12), 20, 0x8d2a4c8a)

    a = hh(a, b, c, d, w(x, i + 5), 4, 0xfffa3942)
    d = hh(d, a, b, c, w(x, i + 8), 11, 0x8771f681)
    c = hh(c, d, a, b, w(x, i + 11), 16, 0x6d9d6122)
    b = hh(b, c, d, a, w(x, i + 14), 23, 0xfde5380c)
    a = hh(a, b, c, d, w(x, i + 1), 4, 0xa4beea44)
    d = hh(d, a, b, c, w(x, i + 4), 11, 0x4bdecfa9)
    c = hh(c, d, a, b, w(x, i + 7), 16, 0xf6bb4b60)
    b = hh(b, c, d, a, w(x, i + 10), 23, 0xbebfbc70)
    a = hh(a, b, c, d, w(x, i + 13), 4, 0x289b7ec6)
    d = hh(d, a, b, c, w(x, i + 0), 11, 0xeaa127fa)
    c = hh(c, d, a, b, w(x, i + 3), 16, 0xd4ef3085)
    b = hh(b, c, d, a, w(x, i + 6), 23, 0x04881d05)
    a = hh(a, b, c, d, w(x, i + 9), 4, 0xd9d4d039)
    d = hh(d, a, b, c, w(x, i + 12), 11, 0xe6db99e5)
    c = hh(c, d, a, b, w(x, i + 15), 16, 0x1fa27cf8)
    b = hh(b, c, d, a, w(x, i + 2), 23, 0xc4ac5665)

    a = ii(a, b, c, d, w(x, i + 0), 6, 0xf4292244)
    d = ii(d, a, b, c, w(x, i + 7), 10, 0x432aff97)
    c = ii(c, d, a, b, w(x, i + 14), 15, 0xab9423a7)
    b = ii(b, c, d, a, w(x, i + 5), 21, 0xfc93a039)
    a = ii(a, b, c, d, w(x, i + 12), 6, 0x655b59c3)
    d = ii(d, a, b, c, w(x, i + 3), 10, 0x8f0ccc92)
    c = ii(c, d, a, b, w(x, i + 10), 15, 0xffeff47d)
    b = ii(b, c, d, a, w(x, i + 1), 21, 0x85845dd1)
    a = ii(a, b, c, d, w(x, i + 8), 6, 0x6fa87e4f)
    d = ii(d, a, b, c, w(x, i + 15), 10, 0xfe2ce6e0)
    c = ii(c, d, a, b, w(x, i + 6), 15, 0xa3014314)
    b = ii(b, c, d, a, w(x, i + 13), 21, 0x4e0811a1)
    a = ii(a, b, c, d, w(x, i + 4), 6, 0xf7537e82)
    d = ii(d, a, b, c, w(x, i + 11), 10, 0xbd3af235)
    c = ii(c, d, a, b, w(x, i + 2), 15, 0x2ad7d2bb)
    b = ii(b, c, d, a, w(x, i + 9), 21, 0xeb86d391)

    a = addUnsigned(a, oldA)
    b = addUnsigned(b, oldB)
    c = addUnsigned(c, oldC)
    d = addUnsigned(d, oldD)
  }

  return wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)
}
