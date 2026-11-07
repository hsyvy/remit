/**
 * The slice of PayPal's Orders and Payments APIs the wallet uses for holds.
 * Two implementations: `RestPayPal` (the real sandbox) and `SimulatedPayPal` (local, no account needed).
 */
export interface PayPalGateway {
  readonly mode: "sandbox" | "simulated";

  /** POST /v2/checkout/orders with intent AUTHORIZE. Returns the page where the owner approves. */
  createAuthorizeOrder(input: CreateOrderInput): Promise<{ orderId: string; approveUrl: string }>;

  /** GET /v2/checkout/orders/{id} */
  getOrderStatus(orderId: string): Promise<string>;

  /** POST /v2/checkout/orders/{id}/authorize. Places the hold. */
  authorizeOrder(orderId: string): Promise<Authorization>;

  /** POST /v2/payments/authorizations/{id}/capture. Partial unless `finalCapture`. */
  capture(authorizationId: string, input: CaptureInput): Promise<{ captureId: string; status: string }>;

  /** POST /v2/payments/authorizations/{id}/reauthorize. Restarts the 3-day honor period. */
  reauthorize(authorizationId: string, cents: number): Promise<Authorization>;

  /** POST /v2/payments/authorizations/{id}/void. Releases the hold. */
  voidAuthorization(authorizationId: string): Promise<void>;

  /** POST /v2/payments/captures/{id}/refund */
  refund(captureId: string, cents: number, idempotencyKey: string): Promise<{ refundId: string }>;
}

export interface CreateOrderInput {
  referenceId: string;
  description: string;
  items: { name: string; description: string; cents: number }[];
  returnUrl: string;
  cancelUrl: string;
}

export interface CaptureInput {
  cents: number;
  finalCapture: boolean;
  note: string;
  /** Sent as PayPal-Request-Id, so a retried capture is not taken twice. */
  idempotencyKey: string;
}

export interface Authorization {
  authorizationId: string;
  cents: number;
  expiresAt: string;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** PayPal's `details[0].issue`, e.g. MAX_CAPTURE_AMOUNT_EXCEEDED or PREVIOUSLY_CAPTURED. */
    readonly issue?: string,
    readonly debugId?: string,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

/** PayPal guarantees captured funds for 3 days after authorization. */
export const HONOR_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
/** Authorizations can be captured for up to 29 days. */
export const AUTHORIZATION_MS = 29 * 24 * 60 * 60 * 1000;
