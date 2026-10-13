import { beforeEach, describe, expect, it, vi } from "vitest";
import { auctionCards, cardKey } from "../services/auction-cards";
import { CARD_MANDATE_VERSION, TERMS_VERSION } from "../shared/legal";

const user = {
  id: "collector",
  email: "collector@example.invalid",
  admin: false,
};
const address = {
  name: "Example Collector",
  address: {
    line1: "Example 1",
    city: "Zurich",
    postal_code: "8000",
    country: "CH",
  },
};
let a: any, card: any;
const profile = { sizes: ["M"], country: "CH" };
const client = {
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
  setupIntents: { retrieve: vi.fn() },
  paymentMethods: { retrieve: vi.fn() },
  paymentIntents: { create: vi.fn(), retrieve: vi.fn(), cancel: vi.fn() },
};
const send = vi.fn(async (command: any): Promise<any> => {
  const p = command.input;
  if (command.constructor.name === "GetCommand")
    return {
      Item: structuredClone(
        p.Key.pk.startsWith("CARD#")
          ? card
          : p.Key.pk.startsWith("USER#")
            ? profile
            : a,
      ),
    };
  if (command.constructor.name === "PutCommand") {
    if (p.ConditionExpression === "attribute_not_exists(pk)" && card)
      throw Object.assign(Error(), { name: "ConditionalCheckFailedException" });
    card = structuredClone(p.Item);
    return {};
  }
  if (command.constructor.name === "UpdateCommand") {
    const row = p.Key.pk.startsWith("CARD#") ? card : a;
    if (
      p.ConditionExpression.includes(
        "attribute_not_exists(cardChargeStartedAt)",
      ) &&
      row.cardChargeStartedAt
    )
      throw Object.assign(Error(), { name: "ConditionalCheckFailedException" });
    const expression = p.UpdateExpression.replace(/^SET /, "").split(
      " ADD ",
    )[0];
    for (const pair of expression.split(",")) {
      const [key, value] = pair.trim().split("=");
      row[key.trim()] = p.ExpressionAttributeValues[value.trim()];
    }
    if (p.UpdateExpression.includes("ADD revision")) row.revision++;
    return {};
  }
  return {};
});
const commit = vi.fn(async (changes: any[], _meta: any) => {
  for (const c of changes)
    if (c.Put?.Item.pk.startsWith("CARD#")) card = structuredClone(c.Put.Item);
});
const paid = vi.fn(async () => {
  a.status = "sold";
});
const service = auctionCards(
  { send } as any,
  "auction",
  commit as any,
  async () => ({ client: client as any }),
  paid,
);
const consent = {
  accepted: true,
  adult: true,
  termsVersion: TERMS_VERSION,
  mandateVersion: CARD_MANDATE_VERSION,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CHECKOUT_ENABLED", "true");
  vi.stubEnv("SITE_URL", "https://hewge.design");
  a = {
    pk: "AUCTION#original",
    sk: "HEAD",
    id: "original",
    name: "Original",
    slug: "original",
    status: "scheduled",
    opensAt: Date.now() - 1000,
    closesAt: Date.now() + 3600000,
    termsVersion: TERMS_VERSION,
    countries: ["CH"],
    size: "M",
    revision: 1,
    offerId: "offer",
    offerAmount: 50000,
    shippingFee: 1500,
    winnerId: user.id,
  };
  card = {
    ...cardKey(a.id, user.id),
    userId: user.id,
    status: "verified",
    termsVersion: TERMS_VERSION,
    mandateVersion: CARD_MANDATE_VERSION,
    attempt: "setup-attempt",
    hasBid: true,
    cardExpiresAt: Date.now() + 365 * 86400000,
    customerId: "cus_1",
    paymentMethodId: "pm_1",
    shipping: address,
    brand: "visa",
    last4: "4242",
  };
  client.customers.create.mockResolvedValue({ id: "cus_1" });
  client.checkout.sessions.create.mockResolvedValue({
    id: "cs_1",
    url: "https://checkout.stripe.com/test",
  });
  client.checkout.sessions.retrieve.mockResolvedValue({
    id: "cs_1",
    mode: "setup",
    status: "complete",
    setup_intent: "seti_1",
    customer: "cus_1",
    client_reference_id: user.id,
    metadata: {
      purpose: "auction-card",
      auctionId: a.id,
      userId: user.id,
      attempt: "setup-attempt",
    },
  });
  client.setupIntents.retrieve.mockResolvedValue({
    id: "seti_1",
    customer: "cus_1",
    payment_method: "pm_1",
    status: "succeeded",
    usage: "off_session",
  });
  client.paymentMethods.retrieve.mockResolvedValue({
    id: "pm_1",
    type: "card",
    customer: "cus_1",
    billing_details: address,
    card: {
      brand: "visa",
      last4: "4242",
      exp_year: new Date().getUTCFullYear() + 2,
      exp_month: 12,
    },
  });
  client.paymentIntents.create.mockResolvedValue({
    id: "pi_1",
    status: "succeeded",
  });
  client.paymentIntents.retrieve.mockResolvedValue({
    id: "pi_1",
    status: "succeeded",
  });
  client.paymentIntents.cancel.mockResolvedValue({
    id: "pi_1",
    status: "canceled",
  });
});

describe("card verification and bid permission", () => {
  it("fails closed before launch and without explicit release-specific authorisation", async () => {
    vi.stubEnv("CHECKOUT_ENABLED", "false");
    await expect(service.start(a.id, consent, user)).rejects.toThrow(
      "not open",
    );
    vi.stubEnv("CHECKOUT_ENABLED", "true");
    await expect(
      service.start(a.id, { ...consent, accepted: false }, user),
    ).rejects.toThrow("Accept");
    expect(client.customers.create).not.toHaveBeenCalled();
  });
  it("requires an actual verified setup, current mandate, matching destination and unexpired card", async () => {
    expect(await service.requireCard(a, user, profile)).toMatchObject({
      customerId: "cus_1",
    });
    for (const change of [
      { status: "pending" },
      { mandateVersion: "old" },
      { cardExpiresAt: Date.now() },
      { shipping: { address: { country: "GB" } } },
    ]) {
      const original = card;
      card = { ...card, ...change };
      await expect(service.requireCard(a, user, profile)).rejects.toThrow(
        "Verify your card",
      );
      card = original;
    }
    card = undefined;
    await expect(service.requireCard(a, user, profile)).rejects.toThrow(
      "Verify your card",
    );
  });
  it("records a stable attempt before card-only Stripe setup and minimises public status", async () => {
    card = undefined;
    await service.start(a.id, consent, user);
    expect(card).toMatchObject({
      status: "pending",
      termsVersion: TERMS_VERSION,
      mandateVersion: CARD_MANDATE_VERSION,
      sessionId: "cs_1",
    });
    expect(card.termsHash).toHaveLength(64);
    const params = client.checkout.sessions.create.mock.calls[0][0];
    expect(params).toMatchObject({
      mode: "setup",
      allowed_payment_method_types: ["card"],
      billing_address_collection: "required",
      customer: "cus_1",
    });
    expect(params.line_items).toBeUndefined();
    card.status = "verified";
    card.shipping = address;
    card.cardExpiresAt = Date.now() + 365 * 86400000;
    const status = await service.status(a.id, user);
    expect(status).not.toHaveProperty("customerId");
    expect(status).not.toHaveProperty("paymentMethodId");
  });
  it("ignores an unsigned browser assertion and checks SetupIntent ownership and address", async () => {
    card.status = "pending";
    delete card.hasBid;
    const session = await client.checkout.sessions.retrieve("cs_1");
    client.setupIntents.retrieve.mockResolvedValueOnce({
      status: "succeeded",
      usage: "off_session",
      customer: "cus_foreign",
    });
    await expect(service.finish(session)).rejects.toThrow(
      "bank has not confirmed",
    );
    expect(commit).not.toHaveBeenCalled();
    await service.finish(session);
    expect(card).toMatchObject({
      status: "verified",
      paymentMethodId: "pm_1",
      shipping: address,
    });
    expect(JSON.stringify(commit.mock.calls[0][1])).not.toContain("Example 1");
  });
  it("rejects a completed setup belonging to another account", async () => {
    const session = await client.checkout.sessions.retrieve("cs_1");
    session.client_reference_id = "other";
    await expect(service.finish(session)).rejects.toThrow("does not match");
    expect(client.setupIntents.retrieve).not.toHaveBeenCalled();
  });
  it("never silently replaces a card that backs a binding bid", async () => {
    card.status = "pending";
    await expect(service.start(a.id, consent, user)).rejects.toThrow(
      "backs an accepted bid",
    );
    expect(client.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("winning payment and reconciliation", () => {
  it("charges the server total and only the winner's saved card once", async () => {
    a.status = "awaiting-payment";
    await service.charge(a.id);
    expect(client.paymentIntents.create.mock.calls[0][0]).toMatchObject({
      amount: 51500,
      currency: "chf",
      customer: "cus_1",
      payment_method: "pm_1",
      allowed_payment_method_types: ["card"],
      confirm: true,
      off_session: true,
    });
    expect(paid).toHaveBeenCalledTimes(1);
    await service.charge(a.id);
    expect(client.paymentIntents.create).toHaveBeenCalledTimes(1);
  });
  it("uses one persistent idempotency key across concurrent settlement attempts", async () => {
    a.status = "awaiting-payment";
    client.paymentIntents.create.mockResolvedValue({
      id: "pi_1",
      status: "processing",
    });
    await Promise.all([service.charge(a.id), service.charge(a.id)]);
    const keys = new Set(
      client.paymentIntents.create.mock.calls.map((c) => c[1].idempotencyKey),
    );
    expect(keys.size).toBe(1);
    expect(a.cardPaymentIntentId).toBe("pi_1");
    expect(paid).not.toHaveBeenCalled();
  });
  it("preserves ambiguous attempts and retries with identical parameters", async () => {
    a.status = "awaiting-payment";
    client.paymentIntents.create.mockRejectedValueOnce(Error("network"));
    await expect(service.charge(a.id)).rejects.toThrow("network");
    const attempt = a.cardAttempt;
    await service.charge(a.id);
    expect(client.paymentIntents.create.mock.calls[0]).toEqual(
      client.paymentIntents.create.mock.calls[1],
    );
    expect(a.cardAttempt).toBe(attempt);
  });
  it("does not recreate an unresolved attempt after the idempotency safety period", async () => {
    a.status = "awaiting-payment";
    a.cardChargeStartedAt = Date.now() - 24 * 3600000;
    a.cardAttempt = "old";
    await expect(service.prepareCheckout(a)).rejects.toThrow(
      "must not be recreated",
    );
    expect(client.paymentIntents.create).not.toHaveBeenCalled();
    expect(client.paymentIntents.cancel).not.toHaveBeenCalled();
  });
  it("blocks fallback payment while the original is processing", async () => {
    a.status = "awaiting-payment";
    a.cardChargeStartedAt = Date.now();
    a.cardAttempt = "attempt";
    a.cardPaymentIntentId = "pi_1";
    client.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "processing",
    });
    await expect(service.prepareCheckout(a)).rejects.toThrow(
      "still processing",
    );
    expect(client.paymentIntents.cancel).not.toHaveBeenCalled();
  });
  it("cancels the unsuccessful intent before allowing an authenticated checkout", async () => {
    a.status = "awaiting-payment";
    a.cardChargeStartedAt = Date.now();
    a.cardAttempt = "attempt";
    a.cardPaymentIntentId = "pi_1";
    client.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_action",
    });
    const ready = await service.prepareCheckout(a);
    expect(client.paymentIntents.cancel).toHaveBeenCalledWith(
      "pi_1",
      {},
      { idempotencyKey: "cancel-attempt" },
    );
    expect(ready.status).toBe("awaiting-payment");
    expect(paid).not.toHaveBeenCalled();
  });
  it("does not autocharge losing bidders who receive a later optional offer", async () => {
    a.status = "awaiting-payment";
    a.offerRequiresAcceptance = true;
    await service.charge(a.id);
    expect(client.paymentIntents.create).not.toHaveBeenCalled();
  });
});
