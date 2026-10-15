// Browser-side handling of what navigator.credentials.get() returns or throws.
// Pure functions, kept out of the React code so they can be unit tested.

export type WalletFailure =
  /** The browser refused because the tap was not seen as a user gesture. Same request, tap again. */
  | "retry"
  /** The visitor dismissed the sheet or declined in the wallet. */
  | "cancelled"
  /** The browser or device could not present a wallet at all. */
  | "unavailable";

/**
 * Turns `credential.data` into the string the Cloud SDK expects.
 *
 * The integration guide says `data` is a string for both flows. The official sample app is
 * more defensive, and this follows it: for Flow B it reads `data.response` (the JWE) when
 * `data` is an object, and for Flow A it sends an object as JSON.
 */
export function extractWalletData(protocol: string, data: unknown): string | null {
  if (typeof data === "string") return data === "" ? null : data;
  if (typeof data !== "object" || data === null) return null;
  const response = (data as { response?: unknown }).response;
  if (protocol !== "org-iso-mdoc" && typeof response === "string" && response !== "") return response;
  return JSON.stringify(data);
}

/**
 * Classifies an error thrown by navigator.credentials.get(). Based on the sample app's
 * domExceptionMessage(): a NotAllowedError that mentions transient activation is not the
 * visitor saying no, every other NotAllowedError is.
 */
export function classifyWalletError(err: unknown): WalletFailure {
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : "";
  const message = typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : "";
  if (name === "NotAllowedError" && /transient|activation|user gesture/i.test(message)) return "retry";
  if (name === "NotAllowedError" || name === "AbortError") return "cancelled";
  return "unavailable";
}
