import { piece, type Catalog } from "../shared/catalog";
import { preview } from "../shared/auction";
export type Config = {
  apiUrl: string;
  userPoolId?: string;
  clientId?: string;
  region?: string;
};
let config: Promise<Config>;
export const getConfig = () =>
  (config ??= fetch("/config.json", { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw Error("Configuration unavailable.");
    return r.json();
  }));
export function getToken() {
  return sessionStorage.getItem("hewge-token") || "";
}
export function signOut() {
  sessionStorage.removeItem("hewge-token");
}
export async function api(path: string, body?: unknown) {
  const c = await getConfig();
  if (!c.apiUrl) throw Error("The live service is available at hewge.design.");
  const token = getToken();
  const r = await fetch(`${c.apiUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 401) signOut();
    throw Error(data.message || "Please try again.");
  }
  return data;
}
export async function getCatalog(): Promise<Catalog> {
  if (!(await getConfig()).apiUrl) return { ...piece, status: "coming-soon" };
  return api("/catalog");
}
export async function getReleases() {
  if (!(await getConfig()).apiUrl)
    return { releases: [preview], biddingEnabled: false };
  return api("/releases");
}
export const joinList = (
  email: string,
  website: string,
  sizes: string[] = [],
) => api("/waitlist", { email, website, sizes, consent: true });
export const leaveList = (email: string) => api("/waitlist/remove", { email });
export async function cognito(action: string, body: Record<string, unknown>) {
  const c = await getConfig();
  if (!c.clientId) throw Error("Collector accounts will open shortly.");
  const r = await fetch(`https://cognito-idp.${c.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify({ ClientId: c.clientId, ...body }),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.message || "Check your details and try again.");
  return data;
}
export async function signIn(email: string, password: string) {
  const data = await cognito("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  if (!data.AuthenticationResult?.IdToken)
    throw Error("Finish your email verification before signing in.");
  sessionStorage.setItem("hewge-token", data.AuthenticationResult.IdToken);
}
