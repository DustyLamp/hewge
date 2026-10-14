// Bounded real-AWS rehearsal. Credentials and MFA secrets stay in memory.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { enrollStudio } from "./qa-security.mjs";
const region = "eu-north-1";
assert.equal(process.env.AWS_PROFILE, "hewge");
const stack = (
  await new CloudFormationClient({ region }).send(
    new DescribeStacksCommand({ StackName: "hewge-production" }),
  )
).Stacks[0];
assert.equal(stack.StackId.split(":")[4], "082229154968");
const o = Object.fromEntries(
  stack.Outputs.map((v) => [v.OutputKey, v.OutputValue]),
);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const cognito = new CognitoIdentityProviderClient({ region });
const username = `hewge-bidding-qa-${randomUUID()}@example.invalid`,
  password = `Qa9${randomBytes(24).toString("hex")}`;
let token,
  studio,
  userId,
  id,
  created = false;
const sockets = [];
const rehearsalIds = new Set();
async function request(path, body, authenticated = true) {
  const r = await fetch(o.ApiUrl + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: "https://hewge.design",
      "Content-Type": "application/json",
      ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
      ...(authenticated && studio ? { "X-Hewge-Studio": studio } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  const data = await r.json();
  if (path === "/admin/rehearsal" && body?.action === "create" && r.ok)
    rehearsalIds.add(data.release.id);
  return {
    status: r.status,
    data,
    serverTime: Date.parse(r.headers.get("date")),
  };
}
function open(t) {
  const auth = { host: t.http, Authorization: t.token };
  const ws = new WebSocket(`wss://${t.realtime}/event/realtime`, [
    "aws-appsync-event-ws",
    `header-${Buffer.from(JSON.stringify(auth)).toString("base64url")}`,
  ]);
  sockets.push(ws);
  const events = [];
  const waiters = [];
  ws.addEventListener("open", () =>
    ws.send(JSON.stringify({ type: "connection_init" })),
  );
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    events.push(m);
    for (const w of [...waiters])
      if (w.p(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timeout);
        w.resolve(m);
      }
  });
  const wait = (p) =>
    new Promise((resolve, reject) => {
      const found = events.find(p);
      if (found) return resolve(found);
      const w = {
        p,
        resolve,
        timeout: setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(
            Error(
              "WebSocket response timed out: " +
                JSON.stringify(events.map((e) => e.type)),
            ),
          );
        }, 20000),
      };
      waiters.push(w);
    });
  return {
    ws,
    wait,
    auth,
    events,
    async subscribe(channel = t.channel, subscriptionId = "auction") {
      await wait((m) => m.type === "connection_ack");
      ws.send(
        JSON.stringify({
          type: "subscribe",
          id: subscriptionId,
          channel,
          authorization: auth,
        }),
      );
      return wait(
        (m) =>
          m.id === subscriptionId &&
          ["subscribe_success", "subscribe_error"].includes(m.type),
      );
    },
  };
}
try {
  const publicBefore = await request("/auction/toucan-001", undefined, false);
  assert.equal(publicBefore.status, 200);
  assert.equal(publicBefore.data.biddingEnabled, false);
  assert.equal(publicBefore.data.release.bidCount, 0);
  assert.equal(
    (await request("/admin/rehearsals", undefined, false)).status,
    403,
  );
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: o.UserPoolId,
      Username: username,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: username },
        { Name: "email_verified", Value: "true" },
      ],
    }),
  );
  created = true;
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: o.UserPoolId,
      Username: username,
      Password: password,
      Permanent: true,
    }),
  );
  const login = await cognito.send(
    new InitiateAuthCommand({
      ClientId: o.UserPoolClientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  token = login.AuthenticationResult.IdToken;
  userId = JSON.parse(Buffer.from(token.split(".")[1], "base64url")).sub;
  assert.equal(
    (
      await request("/admin/rehearsal", {
        action: "create",
        pieceId: "toucan-001",
      })
    ).status,
    403,
  );
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: o.UserPoolId,
      Username: username,
      GroupName: "admins",
    }),
  );
  const security = await enrollStudio(request, username, password);
  token = security.idToken;
  studio = security.adminSession;
  const withoutMfa = studio;
  studio = undefined;
  assert.equal((await request("/admin/rehearsals")).status, 401);
  studio = withoutMfa;
  const before = (
    await db.send(
      new GetCommand({
        TableName: o.AuctionTableName,
        Key: { pk: "AUCTION#toucan-001", sk: "HEAD" },
        ConsistentRead: true,
      }),
    )
  ).Item;
  const start = await request("/admin/rehearsal", {
    action: "create",
    pieceId: "toucan-001",
  });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  id = start.data.release.id;
  assert.equal((await request(`/auction/${id}`, undefined, false)).status, 404);
  assert.equal((await request(`/live/${id}`, undefined, false)).status, 404);
  assert.equal(
    (await request(`/admin/rehearsal/${id}`, undefined, false)).status,
    403,
  );
  const t = await request("/admin/rehearsal/ticket", { id });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const stream = open(t.data);
  assert.equal((await stream.subscribe()).type, "subscribe_success");
  assert.equal(
    (await stream.subscribe("/rehearsal/*", "wildcard")).type,
    "subscribe_error",
  );
  stream.ws.send(
    JSON.stringify({
      type: "publish",
      id: "forbidden",
      channel: t.data.channel,
      authorization: stream.auth,
      events: ['{"revision":999999}'],
    }),
  );
  assert.equal(
    (await stream.wait((m) => m.id === "forbidden")).type,
    "publish_error",
  );
  const publicTicket = await request("/live/toucan-001", undefined, false);
  const publicStream = open(publicTicket.data);
  assert.equal((await publicStream.subscribe()).type, "subscribe_success");
  assert.equal(
    (await publicStream.subscribe(t.data.channel, "private-denied")).type,
    "subscribe_error",
  );
  console.log(
    "MFA, private/public channel isolation, wildcard denial and client-publish denial verified.",
  );
  const bodies = Array.from({ length: 6 }, (_, i) => ({
    action: "bid",
    id,
    bidder: i % 2 ? "collector-a" : "you",
    amount: start.data.release.openingBid,
    requestId: randomUUID(),
  }));
  const outcomes = await Promise.all(
    bodies.map((b) => request("/admin/rehearsal", b)),
  );
  assert.equal(
    outcomes.filter((r) => r.status === 200).length,
    1,
    JSON.stringify(outcomes),
  );
  assert.ok(
    outcomes.every((r) => [200, 400, 409].includes(r.status)),
    JSON.stringify(outcomes),
  );
  const accepted = outcomes.findIndex((r) => r.status === 200);
  await stream.wait(
    (m) =>
      m.type === "data" &&
      (Array.isArray(m.event) ? m.event : [m.event]).some(
        (v) => (typeof v === "string" ? JSON.parse(v) : v).revision === 2,
      ),
  );
  const snapshot = await request(`/admin/rehearsal/${id}`);
  assert.equal(snapshot.data.release.bidCount, 1);
  assert.equal(snapshot.data.release.recentBids.length, 1);
  const replay = await request("/admin/rehearsal", bodies[accepted]);
  assert.deepEqual(replay.data, outcomes[accepted].data);
  const closed = await request("/admin/rehearsal", { action: "close", id });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.release.status, "closed");
  assert.deepEqual(
    (await request("/admin/rehearsal", bodies[accepted])).data,
    outcomes[accepted].data,
  );
  const late = await request("/admin/rehearsal", {
    ...bodies[accepted],
    requestId: randomUUID(),
    amount: start.data.release.openingBid + 1000,
  });
  assert.equal(late.status, 409);
  assert.equal(
    (
      await request("/admin/rehearsal", {
        ...bodies[accepted],
        amount: start.data.release.openingBid + 1000,
      })
    ).status,
    409,
  );
  const trail = await request("/admin/audit", {
    entity: `rehearsal:${id}`,
    verify: true,
  });
  assert.equal(trail.status, 200, JSON.stringify(trail.data));
  assert.equal(trail.data.verification.events, 3);
  assert.equal(trail.data.verification.archivedReceipts, 3);
  const after = (
    await db.send(
      new GetCommand({
        TableName: o.AuctionTableName,
        Key: { pk: "AUCTION#toucan-001", sk: "HEAD" },
        ConsistentRead: true,
      }),
    )
  ).Item;
  assert.deepEqual(after, before);
  const released = await request("/releases", undefined, false);
  assert.equal(released.data.biddingEnabled, false);
  assert.ok(released.data.releases.every((a) => a.id !== id));
  console.log(
    "Six simultaneous bids: one accepted, five rejected; live committed revision delivered; replay, closing and late rejection verified.",
  );
  console.log("Public After Hours, payment gate and ownership unchanged.");
  if (process.env.HEWGE_PLAYWRIGHT_MODULE) {
    const { createRequire } = await import("node:module");
    const engines = createRequire(import.meta.url)(
      process.env.HEWGE_PLAYWRIGHT_MODULE,
    );
    for (const [name, width] of [
      ["webkit", 393],
      ["chromium", 1440],
    ]) {
      const browser = await engines[name].launch();
      try {
        const page = await browser.newPage({
          viewport: { width, height: 950 },
          isMobile: width < 700,
        });
        const errors = [],
          frames = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("websocket", (ws) =>
          ws.on("framereceived", (frame) => {
            try {
              const m = JSON.parse(String(frame.payload));
              if (m.type === "data") frames.push(m);
            } catch {}
          }),
        );
        await page.addInitScript(
          ({ token, studio }) => {
            sessionStorage.setItem("hewge-token", token);
            sessionStorage.setItem("hewge-studio", studio);
          },
          { token, studio },
        );
        await page.route("**/config.json", (r) =>
          r.fulfill({ json: { apiUrl: o.ApiUrl } }),
        );
        await page.route(`${o.ApiUrl}/**`, async (r) => {
          const path = new URL(r.request().url()).pathname;
          // The browser exercise needs only the piece and its private rehearsal,
          // not unrelated collector records from the production dashboard.
          if (path === "/admin")
            return r.fulfill({
              json: {
                auctions: [publicBefore.data.release],
                collectors: [],
                guestlist: [],
                mail: [],
                media: [],
                security: {},
                settings: {},
              },
            });
          const result = await fetch(r.request().url(), {
            method: r.request().method(),
            headers: {
              ...r.request().headers(),
              origin: "https://hewge.design",
            },
            ...(r.request().postData() ? { body: r.request().postData() } : {}),
          });
          const bytes = Buffer.from(await result.arrayBuffer());
          if (
            path === "/admin/rehearsal" &&
            r.request().postDataJSON()?.action === "create" &&
            result.ok
          )
            rehearsalIds.add(JSON.parse(bytes).release.id);
          return r.fulfill({
            status: result.status,
            contentType:
              result.headers.get("content-type") || "application/json",
            body: bytes,
          });
        });
        await page.goto(
          process.env.HEWGE_BROWSER_BASE || "http://127.0.0.1:5181/dashboard",
        );
        await page
          .getByRole("button", { name: "rehearsal", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Start a new rehearsal" })
          .click();
        await page.getByText("Live updates", { exact: true }).waitFor();
        const box = page.locator(".bid-box");
        await box.getByLabel("Your bid · CHF").fill("339");
        await box.getByRole("checkbox").check();
        await box
          .getByRole("button", { name: "Review bid", exact: true })
          .click();
        await box
          .getByRole("button", { name: "Place simulated bid", exact: true })
          .click();
        await page.getByText("Simulated leader: you.").waitFor();
        const currentId = await page
          .locator(".rehearsal-session select")
          .inputValue();
        const other = await request("/admin/rehearsal", {
          action: "bid",
          id: currentId,
          bidder: "collector-a",
          requestId: randomUUID(),
          amount: 34900,
        });
        assert.equal(other.status, 200, JSON.stringify(other.data));
        await page.getByText("Simulated leader: collector-a.").waitFor();
        assert.ok(
          frames.length > 0,
          "No real WebSocket data arrived in the browser",
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await page
          .locator(".rehearsal-panel")
          .screenshot({ path: `output/bidding-live-${name}-${width}.png` });
        await page.getByRole("button", { name: "Close rehearsal now" }).click();
        await page
          .getByText(/Rehearsal closed. Simulated winner: collector-a/)
          .waitFor();
        assert.deepEqual(errors, []);
        console.log(
          `${name} ${width}px: real AWS private bidding, external outbid WebSocket update and closing passed.`,
        );
      } finally {
        await browser.close();
      }
    }
  }
} finally {
  for (const ws of sockets) ws.close();
  for (const pk of [
    ...[...rehearsalIds].map((value) => `REHEARSAL#${value}`),
    userId && `REHEARSALS#${userId}`,
  ].filter(Boolean)) {
    let cursor;
    do {
      const rows = await db.send(
        new QueryCommand({
          TableName: o.AuctionTableName,
          KeyConditionExpression: "pk=:pk",
          ExpressionAttributeValues: { ":pk": pk },
          ExclusiveStartKey: cursor,
          ConsistentRead: true,
        }),
      );
      for (const row of rows.Items || [])
        await db.send(
          new DeleteCommand({
            TableName: o.AuctionTableName,
            Key: { pk: row.pk, sk: row.sk },
          }),
        );
      cursor = rows.LastEvaluatedKey;
    } while (cursor);
  }
  if (userId)
    await db.send(
      new DeleteCommand({
        TableName: o.AuctionTableName,
        Key: { pk: `ADMIN_MFA#${userId}`, sk: "SECURITY" },
      }),
    );
  if (created)
    await cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: o.UserPoolId,
        Username: username,
      }),
    );
  console.log(
    "Disposable identity and rehearsal rows removed; protected QA audit events retained.",
  );
}
