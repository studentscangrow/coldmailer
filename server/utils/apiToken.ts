import { randomBytes, createHash } from 'node:crypto'

const TOKEN_PREFIX = 'cml_'

export function generateApiToken(): { token: string; tokenHash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  return { token, tokenHash: hashApiToken(token) }
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
