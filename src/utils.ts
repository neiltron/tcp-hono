const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = (str: string): Uint8Array<ArrayBuffer> => encoder.encode(str)
export const decode = (bytes: Uint8Array): string => decoder.decode(bytes)

export const concat = (...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const result = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

/**
 * Create a new Response whose body ends with `suffix` if it does not end with a line feed.
 */
export const endWith = (res: Response, suffix: string): Response => {
  if (!res.body) {
    return res
  }
  let last: number | undefined
  return new Response(
    res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          last = chunk.at(-1) ?? last
          controller.enqueue(chunk)
        },
        flush(controller) {
          if (last !== 10) {
            controller.enqueue(encode(suffix))
          }
        },
      })
    ),
    res
  )
}
