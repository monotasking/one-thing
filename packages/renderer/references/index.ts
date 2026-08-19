export {
  extractPosition,
  isAbsoluteReferencePath,
  isImagePath,
  isWindowsPath,
  parseReference,
  pathToFileUrl,
  type FileReference,
  type ExternalReference,
  type ParseReferenceContext,
  type Reference,
  type ReferenceKind,
  type UrlReference,
} from './parse'
export { findPathSpans, wholePathReference, type PathSpan } from './autolink'
export {
  getReferenceHost,
  openReference,
  setReferenceHost,
  type ReferenceFilePosition,
  type ReferenceHost,
  type ReferenceOpenModifiers,
  type ReferenceOpenResult,
  type ReferenceStat,
} from './open'
export {
  handleReferenceClick,
  installReferenceClickHandler,
  resetReferenceClickHandler,
} from './dom'
