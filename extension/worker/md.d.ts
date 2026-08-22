/**
 * Markdown files are imported as text modules — see the [[rules]] block in
 * wrangler.toml. Declared here so tsc agrees with what the bundler does.
 */
declare module '*.md' {
  const content: string
  export default content
}
