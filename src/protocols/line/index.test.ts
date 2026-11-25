import { describe, expect, it } from 'vite-plus/test'
import { decodeAll, encoder } from '../../test-utils.ts'
import { line, tokenize } from './index.ts'

describe('Line', () => {
  it('Should tokenize a line', () => {
    expect(tokenize('SET foo bar')).toEqual(['SET', 'foo', 'bar'])
    expect(tokenize('  SET \t foo   bar  ')).toEqual(['SET', 'foo', 'bar'])
    expect(tokenize('SET foo "hello world"')).toEqual(['SET', 'foo', 'hello world'])
    expect(tokenize(`SET foo 'hello "world"'`)).toEqual(['SET', 'foo', 'hello "world"'])
    expect(tokenize('SET foo "say \\"hi\\" \\\\"')).toEqual(['SET', 'foo', 'say "hi" \\'])
    expect(tokenize('SET foo ""')).toEqual(['SET', 'foo', ''])
    expect(tokenize('')).toEqual([])
  })

  it('Should decode messages from chunks', () => {
    expect(decodeAll(line(), ['PING\nGET foo\r\nSE', 'T a', ' b\n', '\n\r\n', 'LAST'])).toEqual([
      ['PING'],
      ['GET', 'foo'],
      ['SET', 'a', 'b'],
    ])
    expect(decodeAll(line(), ['PING\nLAST', undefined])).toEqual([['PING'], ['LAST']])
  })

  it('Should keep the state of each connection separately', () => {
    const protocol = line()
    const a = protocol.decode()
    const b = protocol.decode()
    expect([...a(encoder.encode('HEL'))]).toEqual([])
    expect([...b(encoder.encode('PI'))]).toEqual([])
    expect([...a(encoder.encode('LO\n'))].map((m) => m.args)).toEqual([['HELLO']])
    expect([...b(encoder.encode('NG\n'))].map((m) => m.args)).toEqual([['PING']])
  })

  it('Should throw if a line exceeds the max length', () => {
    expect(() => decodeAll(line({ maxLength: 8 }), ['12345678\n'])).not.toThrow()
    expect(() => decodeAll(line({ maxLength: 8 }), ['123456789\n'])).toThrow('Line too long')
    expect(() => decodeAll(line({ maxLength: 8 }), ['12345', '6789'])).toThrow('Line too long')
  })
})
