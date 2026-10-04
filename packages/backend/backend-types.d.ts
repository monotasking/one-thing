/**
 * Type declarations for main process
 */

// Allow importing .txt files as modules
declare module '*.txt' {
  const content: string
  export default content
}
