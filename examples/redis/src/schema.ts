import * as v from 'valibot'

const key = v.pipe(v.string(), v.maxLength(512))

export const setSchema = v.object({
  key,
  value: v.pipe(v.string(), v.maxLength(64 * 1024)),
})

export const incrBySchema = v.object({
  key,
  increment: v.pipe(v.string(), v.regex(/^-?\d+$/), v.transform(Number), v.safeInteger()),
})
