import { randomBytes } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  SetUserMFAPreferenceCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { digest, type Commit } from "./audit";
const fail = (
  message = "Studio sign-in could not be completed. Sign in again.",
) => {
  throw Object.assign(Error(message), { status: 401 });
};
export function studioSecurity(
  db: DynamoDBDocumentClient,
  pool: CognitoIdentityProviderClient,
  table: string,
  verify: (token: string) => Promise<any>,
  commit: Commit,
) {
  const get = async (pk: string) =>
    (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: { pk, sk: "SECURITY" },
          ConsistentRead: true,
        }),
      )
    ).Item;
  const admin = (u: any) =>
    u.email_verified === true &&
    ((u["cognito:groups"] || []).includes("admins") ||
      String(u.email).toLowerCase() === process.env.OWNER_EMAIL);
  async function ticket(record: any) {
    const token = randomBytes(32).toString("hex");
    await db.send(
      new PutCommand({
        TableName: table,
        Item: {
          pk: `AUTH_CHALLENGE#${digest(token)}`,
          sk: "SECURITY",
          ...record,
          expiresAt: Math.floor(Date.now() / 1000) + 180,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return token;
  }
  async function consume(token: unknown) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      return fail();
    const pk = `AUTH_CHALLENGE#${digest(token)}`;
    const record = await get(pk);
    if (!record || record.expiresAt <= Date.now() / 1000) return fail();
    await db.send(
      new DeleteCommand({
        TableName: table,
        Key: { pk, sk: "SECURITY" },
        ConditionExpression: "expiresAt>:now",
        ExpressionAttributeValues: { ":now": Math.floor(Date.now() / 1000) },
      }),
    );
    return record;
  }
  async function issue(idToken: string, user: any) {
    if (!admin(user)) return fail("Owner access required.");
    const token = randomBytes(32).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    await commit(
      [
        {
          Put: {
            TableName: table,
            Item: {
              pk: `ADMIN_SESSION#${digest(token)}`,
              sk: "SECURITY",
              userId: user.sub,
              tokenHash: digest(idToken),
              expiresAt,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
      {
        entity: `security:${user.sub}`,
        actor: user.sub,
        action: "admin-mfa-session-issued",
      },
    );
    return { idToken, adminSession: token, expiresAt };
  }
  async function handleRequest(path: string, body: any) {
    const ClientId = process.env.USER_POOL_CLIENT_ID!;
    if (path === "/security/login") {
      if (typeof body.email !== "string" || typeof body.password !== "string")
        return fail();
      const email = body.email.trim().toLowerCase();
      let result;
      try {
        result = await pool.send(
          new InitiateAuthCommand({
            ClientId,
            AuthFlow: "USER_PASSWORD_AUTH",
            AuthParameters: { USERNAME: email, PASSWORD: body.password },
          }),
        );
      } catch {
        return fail();
      }
      if (result.ChallengeName === "SOFTWARE_TOKEN_MFA" && result.Session)
        return {
          challenge: "totp",
          ticket: await ticket({
            kind: "totp",
            session: result.Session,
            username: result.ChallengeParameters?.USER_ID_FOR_SRP || email,
          }),
        };
      const auth = result.AuthenticationResult;
      if (!auth?.IdToken || !auth.AccessToken) return fail();
      const user = await verify(auth.IdToken);
      if (!admin(user)) return fail("Owner access required.");
      if (await get(`ADMIN_MFA#${user.sub}`))
        return fail(
          "Studio MFA was disabled. Contact Hewge for a reviewed recovery; password-only re-enrolment is blocked.",
        );
      const setup = await pool.send(
        new AssociateSoftwareTokenCommand({ AccessToken: auth.AccessToken }),
      );
      return {
        challenge: "setup",
        secret: setup.SecretCode,
        ticket: await ticket({
          kind: "setup",
          accessToken: auth.AccessToken,
          idToken: auth.IdToken,
          userId: user.sub,
        }),
      };
    }
    if (path === "/security/respond") {
      const t = await consume(body.ticket);
      if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code))
        return fail(
          "Enter the six-digit authenticator code, then sign in again.",
        );
      if (t.kind === "setup") {
        const result = await pool.send(
          new VerifySoftwareTokenCommand({
            AccessToken: t.accessToken,
            UserCode: body.code,
            FriendlyDeviceName: "Hewge studio",
          }),
        );
        if (result.Status !== "SUCCESS") return fail();
        await pool.send(
          new SetUserMFAPreferenceCommand({
            AccessToken: t.accessToken,
            SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
          }),
        );
        const user = await verify(t.idToken);
        if (user.sub !== t.userId || !admin(user)) return fail();
        await commit(
          [
            {
              Put: {
                TableName: table,
                Item: {
                  pk: `ADMIN_MFA#${user.sub}`,
                  sk: "SECURITY",
                  enrolledAt: Date.now(),
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
          {
            entity: `security:${user.sub}`,
            actor: user.sub,
            action: "admin-mfa-enrolled",
          },
        );
        return issue(t.idToken, user);
      }
      if (t.kind !== "totp") return fail();
      const result = await pool.send(
        new RespondToAuthChallengeCommand({
          ClientId,
          ChallengeName: "SOFTWARE_TOKEN_MFA",
          Session: t.session,
          ChallengeResponses: {
            USERNAME: t.username,
            SOFTWARE_TOKEN_MFA_CODE: body.code,
          },
        }),
      );
      const idToken = result.AuthenticationResult?.IdToken;
      if (!idToken) return fail();
      return issue(idToken, await verify(idToken));
    }
    return fail();
  }
  async function requireSession(
    userId: string,
    idToken: string,
    token: string,
  ) {
    if (!/^[a-f0-9]{64}$/.test(token))
      return fail("Sign in to the studio with your authenticator.");
    const session = await get(`ADMIN_SESSION#${digest(token)}`);
    if (
      !session ||
      session.expiresAt <= Date.now() / 1000 ||
      session.userId !== userId ||
      session.tokenHash !== digest(idToken)
    )
      return fail(
        "Your studio session expired. Sign in with your authenticator.",
      );
  }
  async function handle(path: string, body: any) {
    try {
      return await handleRequest(path, body);
    } catch (e: any) {
      if (
        [
          "CodeMismatchException",
          "EnableSoftwareTokenMFAException",
          "NotAuthorizedException",
          "ExpiredCodeException",
        ].includes(e.name)
      )
        return fail(
          "The authenticator code could not be verified. Check your device’s automatic time setting and sign in again with a fresh code.",
        );
      throw e;
    }
  }
  return { handle, requireSession };
}
