import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

export interface RpInfo {
  /** RP ID — the registrable host of the origin (e.g. "ccanywhere.example.com"). */
  readonly rpID: string;
  /** Display name shown by the authenticator. */
  readonly rpName: string;
  /** Full origin URL the SPA is served from (used as expectedOrigin). */
  readonly origin: string;
}

export function deriveRpInfo(webOrigin: string, rpName = 'CC anywhere'): RpInfo {
  const url = new URL(webOrigin);
  return { rpID: url.hostname, rpName, origin: webOrigin };
}

interface RegistrationOptionsResult {
  readonly options: PublicKeyCredentialCreationOptionsJSON;
  readonly challenge: string;
}

export async function makeRegistrationOptions(input: {
  rp: RpInfo;
  /** Stable opaque user id; we use the device's pendingId. */
  userId: string;
  /** Visible name shown by the authenticator UI. */
  userName: string;
  excludeCredentialIds?: ReadonlyArray<string>;
}): Promise<RegistrationOptionsResult> {
  const options = await generateRegistrationOptions({
    rpName: input.rp.rpName,
    rpID: input.rp.rpID,
    userID: new TextEncoder().encode(input.userId),
    userName: input.userName,
    attestationType: 'none',
    excludeCredentials:
      input.excludeCredentialIds?.map((id) => ({ id, transports: ['internal', 'hybrid'] })) ?? [],
    authenticatorSelection: {
      userVerification: 'preferred',
      residentKey: 'preferred',
    },
    timeout: 60_000,
  });
  return { options, challenge: options.challenge };
}

export interface RegisteredCredential {
  readonly credentialId: string;
  /** Base64url-encoded COSE public key. */
  readonly publicKey: string;
  readonly counter: number;
}

export async function verifyRegistration(input: {
  rp: RpInfo;
  expectedChallenge: string;
  attestation: RegistrationResponseJSON;
}): Promise<RegisteredCredential> {
  const verification = await verifyRegistrationResponse({
    response: input.attestation,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.rp.origin,
    expectedRPID: input.rp.rpID,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new CredentialError('attestation verification failed');
  }
  const { credential } = verification.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
  };
}

interface AuthenticationOptionsResult {
  readonly options: PublicKeyCredentialRequestOptionsJSON;
  readonly challenge: string;
}

export async function makeAuthenticationOptions(input: {
  rp: RpInfo;
  credentialId: string;
}): Promise<AuthenticationOptionsResult> {
  const options = await generateAuthenticationOptions({
    rpID: input.rp.rpID,
    userVerification: 'preferred',
    allowCredentials: [{ id: input.credentialId, transports: ['internal', 'hybrid'] }],
    timeout: 60_000,
  });
  return { options, challenge: options.challenge };
}

export interface AuthenticationVerification {
  /** Updated counter; persist this. Replay protection. */
  readonly newCounter: number;
}

export async function verifyAuthentication(input: {
  rp: RpInfo;
  expectedChallenge: string;
  device: { credentialId: string; publicKey: string; counter: number };
  assertion: AuthenticationResponseJSON;
}): Promise<AuthenticationVerification> {
  const verification = await verifyAuthenticationResponse({
    response: input.assertion,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.rp.origin,
    expectedRPID: input.rp.rpID,
    credential: {
      id: input.device.credentialId,
      publicKey: Buffer.from(input.device.publicKey, 'base64url'),
      counter: input.device.counter,
    },
    requireUserVerification: false,
  });
  if (!verification.verified) {
    throw new CredentialError('assertion verification failed');
  }
  return { newCounter: verification.authenticationInfo.newCounter };
}
