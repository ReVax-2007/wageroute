/**
 * Tests run on a page that has no cipher.
 *
 * A browser hands out SubtleCrypto only over a secure context, so the phone app
 * served over `http://192.168.x.x` — the address docs/POCKET.md already names as
 * the shape that installs nothing — has `crypto.getRandomValues` and no
 * `crypto.subtle` at all. Nothing in Node can make that state by serving an
 * insecure page, so the tests reach it the way the browser does: by taking the
 * property away. `subtle` is a configurable getter on the webcrypto object, so an
 * own value shadows it and deleting that value gives it back.
 */
export async function withoutCipher<T>(run: () => Promise<T>): Promise<T> {
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: undefined })
  try {
    return await run()
  } finally {
    delete (globalThis.crypto as { subtle?: unknown }).subtle
  }
}
