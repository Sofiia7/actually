/**
 * Build-time stand-in for sharp - see tsup.config.ts.
 *
 * @xenova/transformers imports sharp for image inputs and checks at load time
 * that it is there (a falsy default export makes it throw), but this server
 * only ever embeds text, so nothing calls it. Shipping the real package cost
 * every install ~50 MB of native libvips and a high-severity advisory
 * (2026-09-08 audit F11).
 */
export default function sharp(): never {
  throw new Error('image input is not supported by actually-mcp-server, which only embeds text')
}
