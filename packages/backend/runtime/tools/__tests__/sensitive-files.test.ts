import { describe, expect, it } from 'vitest'
import { classifySensitiveFile } from '../sensitive-files.js'

describe('runtime sensitive-files', () => {
  it('classifies env secret files as sensitive', () => {
    expect(classifySensitiveFile('/repo/.env')).toMatchObject({ sensitive: true, category: 'env' })
    expect(classifySensitiveFile('/repo/.env.local')).toMatchObject({ sensitive: true, category: 'env' })
    expect(classifySensitiveFile('/repo/.env.production.local')).toMatchObject({ sensitive: true, category: 'env' })
  })

  it('allows common env templates', () => {
    expect(classifySensitiveFile('/repo/.env.example')).toEqual({ sensitive: false })
    expect(classifySensitiveFile('/repo/.env.sample')).toEqual({ sensitive: false })
    expect(classifySensitiveFile('/repo/.env.template')).toEqual({ sensitive: false })
  })

  it('classifies key/certificate files as sensitive', () => {
    expect(classifySensitiveFile('/repo/private.pem')).toMatchObject({ sensitive: true, category: 'certificate' })
    expect(classifySensitiveFile('/repo/deploy.key')).toMatchObject({ sensitive: true, category: 'certificate' })
    expect(classifySensitiveFile('/repo/cert.p12')).toMatchObject({ sensitive: true, category: 'certificate' })
  })

  it('classifies ssh and cloud credential paths as sensitive', () => {
    expect(classifySensitiveFile('/Users/me/.ssh/id_rsa')).toMatchObject({ sensitive: true, category: 'ssh' })
    expect(classifySensitiveFile('/Users/me/.aws/credentials')).toMatchObject({ sensitive: true, category: 'cloud' })
    expect(classifySensitiveFile('/Users/me/.kube/config')).toMatchObject({ sensitive: true, category: 'cloud' })
    expect(classifySensitiveFile('/repo/service-account.json')).toMatchObject({ sensitive: true, category: 'cloud' })
    expect(classifySensitiveFile('/repo/api-token.txt')).toMatchObject({ sensitive: true, category: 'token' })
  })
})
