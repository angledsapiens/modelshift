import { createHash, createHmac } from "node:crypto";

/**
 * AWS auth for Bedrock without the AWS SDK: either a Bedrock API key (bearer token)
 * or Signature Version 4 with standard access keys from the environment.
 */

export interface AwsAuth {
  region: string;
  /** Headers to add to a request (Authorization etc.). */
  headers(method: string, url: string, body: string, now?: Date): Record<string, string>;
  kind: "api-key" | "sigv4";
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Signs a request with AWS Signature Version 4. Returns the headers to send
 * (x-amz-date, optional x-amz-security-token, authorization). For services other
 * than S3 the path is encoded once more for the canonical request, as the AWS SDKs do.
 */
export function signV4(
  req: { method: string; url: string; headers?: Record<string, string>; body: string },
  creds: SigV4Credentials,
  region: string,
  service: string,
  now: Date = new Date(),
): Record<string, string> {
  const u = new URL(req.url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const extra: Record<string, string> = { "x-amz-date": amzDate };
  if (creds.sessionToken) extra["x-amz-security-token"] = creds.sessionToken;
  const all: Record<string, string> = { host: u.host };
  for (const [k, v] of Object.entries({ ...(req.headers ?? {}), ...extra })) all[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const path = u.pathname || "/";
  const canonicalPath = service === "s3" ? path : path.split("/").map((seg) => enc(seg)).join("/");
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [req.method.toUpperCase(), canonicalPath, query, canonicalHeaders, signedHeaders, sha256(req.body)].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign, "utf8").digest("hex");
  return { ...extra, authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

export const BEDROCK_AUTH_HINT =
  "set AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key), or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN). " +
  "With an AWS profile or SSO, export its keys first: aws configure export-credentials --format env";

/** Bedrock auth from the environment; region from AWS_REGION / AWS_DEFAULT_REGION (default us-east-1). */
export function bedrockAuth(env: NodeJS.ProcessEnv, service = "bedrock"): AwsAuth {
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  const token = env.AWS_BEARER_TOKEN_BEDROCK;
  if (token) return { region, kind: "api-key", headers: () => ({ Authorization: `Bearer ${token}` }) };
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error(`Missing AWS credentials for bedrock: ${BEDROCK_AUTH_HINT}`);
  const creds = { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN || undefined };
  return {
    region,
    kind: "sigv4",
    headers: (method, url, body, now) => signV4({ method, url, body, headers: method === "GET" ? {} : { "content-type": "application/json" } }, creds, region, service, now),
  };
}
