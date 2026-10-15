// W3C Digital Credentials API. Not yet in TypeScript's DOM types.
// https://w3c-fedid.github.io/digital-credentials/

interface DigitalCredential extends Credential {
  readonly protocol?: string;
  readonly data: string | Record<string, unknown>;
}

interface DigitalCredentialGetRequest {
  protocol: string;
  data: unknown;
}

interface DigitalCredentialRequestOptions {
  requests: DigitalCredentialGetRequest[];
}

interface CredentialRequestOptions {
  digital?: DigitalCredentialRequestOptions;
}

// User-Agent Client Hints: used only to tell a Samsung phone from other Android phones.
interface NavigatorUAData {
  getHighEntropyValues(hints: string[]): Promise<{ model?: string }>;
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData;
}
