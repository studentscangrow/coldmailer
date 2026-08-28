// server/ files rely on Nitro's ambient auto-imports (createError, getHeader, ...) which only
// exist inside a running Nitro server. Outside of it — i.e. under plain vitest — polyfill the
// handful actually used by tested server/utils files so those files can run unmodified.
import { createError, getHeader } from 'h3'

Object.assign(globalThis, { createError, getHeader })
