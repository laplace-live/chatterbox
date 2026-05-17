import { Md5 } from '../src/lib/md5.ts'

function bunMd5(str: string): string {
  return new Bun.CryptoHasher('md5').update(str).digest('hex')
}

const testCases = [
  '',
  'hello',
  'The quick brown fox jumps over the lazy dog',
  '123456',
  'test@example.com',
  'Hello World!',
  'LAPLACE 弹幕助手',
  '哔哩哔哩直播间',
  'a'.repeat(100),
  'Mixed 中英文 Text 123',
  'special!@#$%^&*()chars',
  '\n\t\r',
  '{"key": "value"}',
  'https://live.bilibili.com/12345',
]

console.log('='.repeat(80))
console.log('MD5 Implementation Comparison Test')
console.log('='.repeat(80))
console.log('')

let passCount = 0
let failCount = 0

for (const [index, testCase] of testCases.entries()) {
  const manualHash = Md5.hashStr(testCase)
  const bunHash = bunMd5(testCase)
  const match = manualHash === bunHash

  if (match) {
    passCount++
  } else {
    failCount++
  }

  const status = match ? '✅ PASS' : '❌ FAIL'
  const displayText = testCase.length > 40 ? `${testCase.substring(0, 37)}...` : testCase

  console.log(`Test ${(index + 1).toString().padStart(2)}: ${status}`)
  console.log(`  Input: "${displayText}"`)
  console.log(`  Manual: ${manualHash}`)
  console.log(`  Bun:    ${bunHash}`)

  if (!match) {
    console.log('  ⚠️  MISMATCH DETECTED!')
  }
  console.log('')
}

console.log('='.repeat(80))
console.log('Test Results Summary')
console.log('='.repeat(80))
console.log(`Total Tests: ${testCases.length}`)
console.log(`Passed: ${passCount} ✅`)
console.log(`Failed: ${failCount} ❌`)
console.log(`Success Rate: ${((passCount / testCases.length) * 100).toFixed(2)}%`)
console.log('='.repeat(80))

if (failCount === 0) {
  console.log('')
  console.log('🎉 All tests passed! The manual MD5 implementation is correct!')
} else {
  console.log('')
  console.log('⚠️  Some tests failed. The manual MD5 implementation has issues with multi-byte characters.')
  console.log('')
  console.log('ANALYSIS:')
  console.log('─'.repeat(80))
  console.log('The manual MD5 implementation works correctly for:')
  console.log('  ✅ ASCII characters (letters, numbers, common symbols)')
  console.log('  ✅ Empty strings')
  console.log('  ✅ Long strings (ASCII)')
  console.log('')
  console.log('The manual MD5 implementation FAILS for:')
  console.log('  ❌ Multi-byte UTF-8 characters (Chinese, emoji, etc.)')
  console.log('')
  console.log('ROOT CAUSE:')
  console.log('  The convertToWordArray() function uses charCodeAt() which returns')
  console.log('  UTF-16 code units, not UTF-8 bytes. This causes incorrect hashing')
  console.log('  for characters outside the ASCII range (0-127).')
  console.log('')
  console.log('RECOMMENDATION:')
  console.log('  For the Bilibili use case (WBI signature), this implementation is')
  console.log('  likely sufficient IF the input parameters are ASCII-only. However,')
  console.log('  if user-generated content with Chinese characters needs to be hashed,')
  console.log('  this implementation will produce incorrect results.')
  console.log('─'.repeat(80))
  process.exit(1)
}
