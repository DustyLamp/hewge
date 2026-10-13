import {
  TERMS_VERSION,
  CARD_MANDATE_VERSION,
  termsText,
} from "../shared/legal";
import { digest } from "../services/audit";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  send: vi.fn(),
  verify: vi.fn(),
  create: vi.fn(),
  retrieve: vi.fn(),
  expire: vi.fn(),
  construct: vi.fn(),
  mail: vi.fn(),
  intentRetrieve: vi.fn(),
  intentCancel: vi.fn(),
  intentCreate: vi.fn(),
  archive: vi.fn(),
}));
vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const actual = await vi.importActual<any>("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mock.send }) },
  };
});
vi.mock("@aws-sdk/client-s3", async () => {
  const actual = await vi.importActual<any>("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: class {
      send = mock.archive;
    },
  };
});
vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: { create: () => ({ verify: mock.verify }) },
}));
vi.mock("@aws-sdk/client-sesv2", async () => {
  const actual = await vi.importActual<any>("@aws-sdk/client-sesv2");
  return {
    ...actual,
    SESv2Client: class {
      send = mock.mail;
    },
  };
});
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send() {
      return Promise.resolve({
        SecretString: JSON.stringify({
          secretKey: "test",
          webhookSecret: "test",
        }),
      });
    }
  },
  GetSecretValueCommand: class {},
}));
vi.mock("stripe", () => ({
  default: class {
    checkout = {
      sessions: {
        create: mock.create,
        retrieve: mock.retrieve,
        expire: mock.expire,
      },
    };
    webhooks = { constructEvent: mock.construct };
    paymentIntents = {
      retrieve: mock.intentRetrieve,
      cancel: mock.intentCancel,
      create: mock.intentCreate,
    };
  },
}));
vi.stubEnv("USER_POOL_ID", "eu-north-1_test");
vi.stubEnv("USER_POOL_CLIENT_ID", "client");
vi.stubEnv("AUCTION_TABLE", "auctions");
vi.stubEnv("AUDIT_TABLE", "audit");
vi.stubEnv("AUDIT_BUCKET", "archive");
vi.stubEnv("TABLE_NAME", "legacy");
vi.stubEnv("ALLOWED_ORIGINS", "https://hewge.design");
vi.stubEnv("OWNER_EMAIL", "jez@hewge.design");
vi.stubEnv("SITE_URL", "https://hewge.design");
const { handler } = await import("../services/platform");
const event = (path: string, body: any = {}, method = "POST") => ({
  rawPath: path,
  body: JSON.stringify(body),
  headers: {
    origin: "https://hewge.design",
    authorization: "Bearer token",
    "x-hewge-studio": "a".repeat(64),
  },
  requestContext: { http: { method, sourceIp: "192.0.2.1" } },
});
const now = Date.now();
const auction = {
  pk: "AUCTION#toucan-001",
  sk: "HEAD",
  id: "toucan-001",
  name: "After Hours",
  number: "001",
  slug: "after-hours",
  image: "/images/shirt-front.webp",
  status: "scheduled",
  published: true,
  opensAt: now - 60000,
  closesAt: now + 3600000,
  openingBid: 33900,
  highestBid: null,
  bidCount: 0,
  minimumIncrement: 1000,
  size: "M",
  countries: ["CH"],
  termsVersion: TERMS_VERSION,
  revision: 1,
  paymentHours: 48,
  shippingFee: 1500,
};
let current: any;
let profile: any;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CHECKOUT_ENABLED", "false");
  vi.stubEnv("EMAIL_ENABLED", "false");
  vi.stubEnv("STRIPE_SECRET_ARN", "test");
  mock.archive.mockResolvedValue({});
  current = { ...auction };
  profile = { sizes: ["M"], country: "CH" };
  mock.mail.mockResolvedValue({
    ProductionAccessEnabled: false,
    SendingEnabled: true,
  });
  mock.verify.mockResolvedValue({
    sub: "collector",
    email: "collector@example.invalid",
    email_verified: true,
  });
  mock.send.mockImplementation(async (cmd: any) => {
    if (cmd.input.TableName === "audit")
      return cmd.constructor.name === "QueryCommand" ? { Items: [] } : {};
    if (
      cmd.constructor.name === "GetCommand" &&
      cmd.input.Key.pk.startsWith("ADMIN_SESSION#")
    )
      return {
        Item: {
          userId: "owner",
          tokenHash: digest("token"),
          expiresAt: Date.now() / 1000 + 900,
        },
      };
    if (
      cmd.constructor.name === "GetCommand" &&
      cmd.input.TableName === "legacy"
    )
      return {};
    if (
      cmd.constructor.name === "GetCommand" &&
      cmd.input.Key.pk.startsWith("CARD#")
    )
      return {
        Item: {
          status: "verified",
          termsVersion: TERMS_VERSION,
          mandateVersion: CARD_MANDATE_VERSION,
          attempt: "card-1",
          hasBid: true,
          cardExpiresAt: now + 365 * 86400000,
          shipping: { address: { country: "CH" } },
        },
      };
    if (
      cmd.constructor.name === "GetCommand" &&
      cmd.input.Key.sk.startsWith("BID#")
    )
      return {};
    if (cmd.constructor.name === "GetCommand")
      return { Item: cmd.input.Key.pk.startsWith("USER#") ? profile : current };
    if (cmd.constructor.name === "QueryCommand")
      return { Items: cmd.input.IndexName === "directory" ? [current] : [] };
    return {};
  });
});
describe("platform access and bidding", () => {
  it("protects the dashboard from ordinary collectors", async () => {
    expect(
      ((await handler(event("/admin", {}, "GET"))) as any).statusCode,
    ).toBe(403);
  });
  it("rejects unverified users even with the owner email", async () => {
    mock.verify.mockResolvedValue({
      sub: "owner",
      email: "jez@hewge.design",
      email_verified: false,
    });
    expect(
      ((await handler(event("/admin", {}, "GET"))) as any).statusCode,
    ).toBe(403);
  });
  it("rejects forged tokens and disallowed origins", async () => {
    mock.verify.mockRejectedValue(Error("bad"));
    expect(((await handler(event("/me", {}, "GET"))) as any).statusCode).toBe(
      401,
    );
    const e = event("/waitlist");
    e.headers.origin = "https://evil.invalid";
    expect(((await handler(e)) as any).statusCode).toBe(403);
  });
  it("does not allow direct checkout or bids before activation", async () => {
    expect(((await handler(event("/checkout"))) as any).statusCode).toBe(409);
    expect(((await handler(event("/bid"))) as any).statusCode).toBe(409);
  });
  it("requires consent and leaves an email-only request unverified", async () => {
    expect(
      (
        (await handler(
          event("/waitlist", { email: "hello@example.invalid" }),
        )) as any
      ).statusCode,
    ).toBe(400);
    expect(
      (
        (await handler(
          event("/waitlist", {
            email: "HELLO@example.invalid",
            consent: true,
            sizes: ["M", "M", "banana"],
          }),
        )) as any
      ).statusCode,
    ).toBe(200);
    const put = mock.send.mock.calls
      .map((c) => c[0])
      .find((c) => c.constructor.name === "PutCommand");
    expect(put.input.Item.sizes).toEqual([]);
    expect(put.input.Item.emailVerified).toBe(false);
    expect(put.input.Item.releaseConsent).toBe(false);
    expect(put.input.Item.email).toBe("hello@example.invalid");
  });
  it("prevents the seller bidding on their own piece", async () => {
    vi.stubEnv("CHECKOUT_ENABLED", "true");
    mock.verify.mockResolvedValue({
      sub: "owner",
      email: "jez@hewge.design",
      email_verified: true,
    });
    expect(((await handler(event("/bid"))) as any).statusCode).toBe(403);
  });
  it("requires matching size, eligible country and accepted terms", async () => {
    vi.stubEnv("CHECKOUT_ENABLED", "true");
    const body = {
      id: auction.id,
      requestId: "11111111-1111-4111-8111-111111111111",
      amount: 33900,
      termsVersion: TERMS_VERSION,
      mandateVersion: CARD_MANDATE_VERSION,
      accepted: true,
      adult: true,
    };
    profile.country = "XX";
    expect(((await handler(event("/bid", body))) as any).statusCode).toBe(409);
    profile.country = "CH";
    profile.sizes = ["L"];
    expect(((await handler(event("/bid", body))) as any).statusCode).toBe(409);
    profile.sizes = ["M"];
    expect(
      ((await handler(event("/bid", { ...body, accepted: false }))) as any)
        .statusCode,
    ).toBe(400);
  });
  it("commits the bid, terms acceptance and head update atomically", async () => {
    vi.stubEnv("CHECKOUT_ENABLED", "true");
    const r = await handler(
      event("/bid", {
        id: auction.id,
        requestId: "11111111-1111-4111-8111-111111111111",
        amount: 33900,
        termsVersion: TERMS_VERSION,
        mandateVersion: CARD_MANDATE_VERSION,
        accepted: true,
        adult: true,
      }),
    );
    expect((r as any).statusCode).toBe(200);
    const tx = mock.send.mock.calls
      .map((c) => c[0])
      .find((c) => c.constructor.name === "TransactWriteCommand")
      .input.TransactItems;
    expect(tx).toHaveLength(7); // business mutation + transactional audit head, event and outbox
    expect(tx[0].Update.ConditionExpression).toContain("revision=:v");
    expect(tx[0].Update.ConditionExpression).toContain("closesAt>:now");
    expect(tx[1].Put.Item).toMatchObject({
      amount: 33900,
      bidderId: "collector",
      termsVersion: TERMS_VERSION,
      mandateVersion: CARD_MANDATE_VERSION,
      accepted: true,
    });
  });
  it("reports a competing bid rather than accepting a stale amount", async () => {
    vi.stubEnv("CHECKOUT_ENABLED", "true");
    const original = mock.send.getMockImplementation()!;
    mock.send.mockImplementation(async (c) => {
      if (c.constructor.name === "TransactWriteCommand")
        throw Object.assign(Error(), { name: "TransactionCanceledException" });
      return original(c);
    });
    expect(
      (
        (await handler(
          event("/bid", {
            id: auction.id,
            requestId: "11111111-1111-4111-8111-111111111111",
            amount: 33900,
            termsVersion: TERMS_VERSION,
            mandateVersion: CARD_MANDATE_VERSION,
            accepted: true,
            adult: true,
          }),
        )) as any
      ).statusCode,
    ).toBe(409);
  });
  it("recovers an accepted bid after a lost response without submitting another write", async () => {
    vi.stubEnv("CHECKOUT_ENABLED", "true");
    current.closesAt = now - 1000;
    const original = mock.send.getMockImplementation()!;
    mock.send.mockImplementation(async (c) =>
      c.constructor.name === "GetCommand" &&
      c.input.Key.sk === "BID#11111111-1111-4111-8111-111111111111"
        ? {
            Item: {
              bidId: "11111111-1111-4111-8111-111111111111",
              bidderId: "collector",
              amount: 33900,
              createdAt: now - 2000,
              sequence: 1,
            },
          }
        : original(c),
    );
    const body = {
      id: auction.id,
      requestId: "11111111-1111-4111-8111-111111111111",
      amount: 33900,
    };
    const r: any = await handler(event("/bid", body));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ amount: 33900, sequence: 1 });
    expect(
      mock.send.mock.calls.filter(
        ([c]) => c.constructor.name === "TransactWriteCommand",
      ),
    ).toHaveLength(0);
    expect(
      ((await handler(event("/bid", { ...body, amount: 34900 }))) as any)
        .statusCode,
    ).toBe(409);
    mock.verify.mockResolvedValue({
      sub: "another-collector",
      email: "another@example.invalid",
      email_verified: true,
    });
    expect(
      JSON.parse(((await handler(event("/bid/receipt", body))) as any).body)
        .receipt,
    ).toBeNull();
  });
  it("rejects ownership claims until payment is confirmed and claimant matches", async () => {
    current.status = "awaiting-payment";
    current.ownerId = "collector";
    expect(
      (
        (await handler(
          event("/owner", {
            id: auction.id,
            requestId: "11111111-1111-4111-8111-111111111111",
            anonymous: false,
            name: "Me",
          }),
        )) as any
      ).statusCode,
    ).toBe(403);
    current.status = "sold";
    current.ownerId = "someone-else";
    expect(
      ((await handler(event("/owner", { id: auction.id }))) as any).statusCode,
    ).toBe(403);
  });
});
describe("money, deadlines and ownership", () => {
  beforeEach(() => {
    vi.stubEnv("CHECKOUT_ENABLED", "true");
    current = {
      ...auction,
      status: "awaiting-payment",
      winnerId: "collector",
      winnerEmail: "collector@example.invalid",
      offerAmount: 45000,
      offerId: "offer-1",
      paymentDueAt: Date.now() + 48 * 3600000,
      checkoutStartedAt: Date.now() - 1000,
      checkoutExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      checkoutAttempt: 1,
    };
  });
  it("uses the stored winning amount, shipping and stable checkout parameters", async () => {
    mock.create.mockResolvedValue({
      id: "cs_test",
      url: "https://checkout.stripe.com/test",
    });
    expect(
      (
        (await handler(
          event("/winner/checkout", {
            id: auction.id,
            requestId: "11111111-1111-4111-8111-111111111111",
            amount: 1,
          }),
        )) as any
      ).statusCode,
    ).toBe(200);
    const [params, options] = mock.create.mock.calls[0];
    expect(params.line_items[0].price_data.unit_amount).toBe(45000);
    expect(
      params.shipping_options[0].shipping_rate_data.fixed_amount.amount,
    ).toBe(1500);
    expect(params.allowed_payment_method_types).toEqual(["card"]);
    expect(params.expires_at).toBe(current.checkoutExpiresAt);
    expect(options.idempotencyKey).toBe("auction-toucan-001-offer-1-1");
  });
  it("will not let a nonwinner pay", async () => {
    current.winnerId = "other";
    expect(
      ((await handler(event("/winner/checkout", { id: auction.id }))) as any)
        .statusCode,
    ).toBe(409);
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("requires fresh acceptance of a later optional offer", async () => {
    current.offerRequiresAcceptance = true;
    expect(
      ((await handler(event("/winner/checkout", { id: auction.id }))) as any)
        .statusCode,
    ).toBe(400);
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("binds an automatic paid intent to the exact customer, winner, offer and attempt", async () => {
    current.cardAttempt = "automatic-1";
    current.cardCustomer = "cus_collector";
    const intent = {
      id: "pi_paid",
      status: "succeeded",
      currency: "chf",
      amount: 46500,
      amount_received: 46500,
      customer: "cus_other",
      metadata: {
        purpose: "auction-winner",
        auctionId: auction.id,
        offerId: "offer-1",
        bidderId: "collector",
        attempt: "automatic-1",
      },
    };
    mock.construct.mockReturnValue({
      type: "payment_intent.succeeded",
      data: { object: intent },
    });
    expect(((await handler(event("/stripe/webhook"))) as any).statusCode).toBe(
      503,
    );
    expect(
      mock.send.mock.calls.some(
        ([c]) => c.constructor.name === "TransactWriteCommand",
      ),
    ).toBe(false);
    intent.customer = "cus_collector";
    expect(((await handler(event("/stripe/webhook"))) as any).statusCode).toBe(
      200,
    );
    const tx = mock.send.mock.calls.find(
      ([c]) => c.constructor.name === "TransactWriteCommand",
    )![0].input.TransactItems;
    expect(tx[0].Put.Item).toMatchObject({
      status: "sold",
      ownerId: "collector",
      cardPaymentIntentId: "pi_paid",
      publicOwner: { anonymous: true, name: null },
    });
    expect(tx[0].Put.ConditionExpression).toContain("revision=:v");
  });
  it("rejects unsigned webhooks and ignores unpaid completion", async () => {
    mock.construct.mockImplementationOnce(() => {
      throw Error();
    });
    expect(((await handler(event("/stripe/webhook"))) as any).statusCode).toBe(
      400,
    );
    mock.construct.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { auctionId: auction.id },
          payment_status: "unpaid",
        },
      },
    });
    expect(((await handler(event("/stripe/webhook"))) as any).statusCode).toBe(
      200,
    );
    expect(
      mock.send.mock.calls.some(
        (c) => c[0].constructor.name === "TransactWriteCommand",
      ),
    ).toBe(false);
  });
  it("never records ownership for a mismatched amount", async () => {
    mock.construct.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test",
          metadata: { auctionId: auction.id, offerId: "offer-1" },
          payment_status: "paid",
          client_reference_id: "collector",
          currency: "chf",
          amount_total: 1,
        },
      },
    });
    expect(((await handler(event("/stripe/webhook"))) as any).statusCode).toBe(
      503,
    );
    expect(
      mock.send.mock.calls.some(
        (c) => c[0].constructor.name === "TransactWriteCommand",
      ),
    ).toBe(false);
  });
  it("makes paid ownership anonymous by default and issues a unique certificate", async () => {
    mock.construct.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test",
          metadata: { auctionId: auction.id, offerId: "offer-1" },
          payment_status: "paid",
          client_reference_id: "collector",
          currency: "chf",
          amount_total: 46500,
        },
      },
    });
    expect(((await handler(event("/stripe/webhook"))) as any).statusCode).toBe(
      200,
    );
    const tx = mock.send.mock.calls
      .map((c) => c[0])
      .find((c) => c.constructor.name === "TransactWriteCommand")
      .input.TransactItems;
    expect(tx[0].Put.Item.publicOwner).toEqual({ name: null, anonymous: true });
    expect(tx[0].Put.Item.certificateId).toMatch(/^HEWGE-001-/);
    expect(tx[1].Put.Item.status).toBe("pending");
  });
  it("does not reassign an uncertain Stripe checkout", async () => {
    mock.verify.mockResolvedValue({
      sub: "owner",
      email: "jez@hewge.design",
      email_verified: true,
    });
    current.paymentDueAt = Date.now() - 1000;
    expect(
      (
        (await handler(
          event("/admin/next-bidder", {
            id: auction.id,
            requestId: "11111111-1111-4111-8111-111111111111",
            confirmed: true,
            reviewReference: "Notice and lawful termination QA reference",
          }),
        )) as any
      ).statusCode,
    ).toBe(409);
  });
  it("settles only after close, preserving the highest bidder", async () => {
    current = {
      ...auction,
      closesAt: Date.now() - 1,
      highestBid: 45000,
      highestBidder: "collector",
      highestBidderEmail: "collector@example.invalid",
    };
    await handler({ source: "aws.events" });
    const tx = mock.send.mock.calls
      .map((c) => c[0])
      .find((c) => c.constructor.name === "TransactWriteCommand")
      .input.TransactItems;
    expect(tx[0].Put.Item).toMatchObject({
      status: "awaiting-payment",
      winnerId: "collector",
      offerAmount: 45000,
    });
    expect(tx[0].Put.ConditionExpression).toBe("revision=:v");
  });
});

describe("public release privacy", () => {
  it("does not publish an owner draft, even when its reveal setting is now", async () => {
    current = {
      ...auction,
      id: "private-draft",
      published: false,
      revealMode: "now",
      artistName: "Private artist",
      material: "Unpublished material",
    };
    const r: any = await handler(event("/releases", {}, "GET"));
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("Private artist");
    expect(r.body).not.toContain("private-draft");
    expect(r.body).not.toContain("Unpublished material");
  });
  it("never returns private owner, bidder or checkout data in the registry", async () => {
    current = {
      ...auction,
      status: "sold",
      certificateId: "CERT",
      soldAt: 1,
      ownerId: "secret-account",
      winnerEmail: "secret@example.invalid",
      sessionId: "secret-checkout",
      fulfillment: { hologramId: "private-seal" },
      publicOwner: { name: null, anonymous: true },
    };
    const r: any = await handler(event("/registry/toucan-001", {}, "GET"));
    expect(r.statusCode).toBe(200);
    for (const secret of [
      "secret-account",
      "secret@example.invalid",
      "secret-checkout",
      "private-seal",
    ])
      expect(r.body).not.toContain(secret);
    expect(JSON.parse(r.body).history).toEqual([{ at: 1, kind: "registered" }]);
  });
  it("does not issue a registry record before payment", async () => {
    current.status = "awaiting-payment";
    expect(
      ((await handler(event("/registry/toucan-001", {}, "GET"))) as any)
        .statusCode,
    ).toBe(404);
  });
});

describe("release audience consent", () => {
  it("excludes pending members and applies the latest verified opt-in or opt-out", async () => {
    vi.stubEnv("EMAIL_ENABLED", "true");
    const until = Math.floor(Date.now() / 1000) + 3600;
    const profiles = [
      { email: "left@example.invalid", releaseConsent: true, consentAt: 10 },
      {
        email: "rejoined@example.invalid",
        releaseConsent: true,
        consentAt: 30,
      },
      {
        email: "account-optout@example.invalid",
        releaseConsent: false,
        consentAt: 30,
      },
    ];
    const guests = [
      {
        email: "pending@example.invalid",
        emailVerified: false,
        releaseConsent: true,
        consentAt: 20,
        expiresAt: until,
      },
      {
        email: "expired@example.invalid",
        emailVerified: true,
        releaseConsent: true,
        consentAt: 20,
        expiresAt: 1,
      },
      {
        email: "left@example.invalid",
        emailVerified: true,
        releaseConsent: false,
        consentAt: 20,
        expiresAt: until,
      },
      {
        email: "rejoined@example.invalid",
        emailVerified: true,
        releaseConsent: false,
        consentAt: 20,
        expiresAt: until,
      },
      {
        email: "account-optout@example.invalid",
        emailVerified: true,
        releaseConsent: true,
        consentAt: 20,
        expiresAt: until,
      },
      {
        email: "member@example.invalid",
        emailVerified: true,
        releaseConsent: true,
        consentAt: 20,
        expiresAt: until,
        sizes: ["M"],
      },
      {
        email: "wrong-size@example.invalid",
        emailVerified: true,
        releaseConsent: true,
        consentAt: 20,
        expiresAt: until,
        sizes: ["XL"],
      },
    ];
    for (const p of profiles) Object.assign(p, { pk: `USER#${p.email}` });
    for (const g of guests)
      Object.assign(g, { pk: `EMAIL#${digest(g.email)}` });
    mock.send.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === "GetCommand")
        return {
          Item: [...profiles, ...guests].find(
            (x: any) => x.pk === cmd.input.Key.pk,
          ),
        };
      if (cmd.constructor.name === "ScanCommand") return { Items: guests };
      if (cmd.constructor.name === "QueryCommand") {
        const kind = Object.values(cmd.input.ExpressionAttributeValues)[0];
        return {
          Items:
            kind === "AUCTIONS"
              ? [current]
              : kind === "COLLECTORS"
                ? profiles
                : [],
        };
      }
      return {};
    });
    await handler({ source: "aws.events" });
    const recipients = mock.send.mock.calls
      .map(([c]) => c.input.Item)
      .filter((i) => i?.sk === "OUTBOX")
      .map((i) => i.email)
      .sort();
    expect(recipients).toEqual([
      "member@example.invalid",
      "rejoined@example.invalid",
    ]);
  });
});
