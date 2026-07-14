// Minimal interface covering the Stripe methods used in this codebase.
// The real Stripe class satisfies this structurally; tests inject fakes.
export interface StripeClient {
  checkout: {
    sessions: {
      create(params: CheckoutSessionCreateParams): Promise<CheckoutSessionResult>;
      retrieve(id: string): Promise<CheckoutSessionStatus>;
    };
  };
  prices: {
    retrieve(id: string): Promise<{ unit_amount: number | null; currency: string }>;
  };
  webhooks: {
    constructEvent(
      payload: Buffer | string,
      header: string | string[],
      secret: string
    ): StripeWebhookEvent;
  };
}

export interface CheckoutSessionCreateParams {
  mode: "payment";
  line_items: Array<{ price: string; quantity: number }>;
  metadata: Record<string, string>;
  success_url: string;
  cancel_url: string;
}

export interface CheckoutSessionResult {
  id: string;
  url: string | null;
}

export interface CheckoutSessionStatus {
  id: string;
  payment_status: string;
}

export interface StripeWebhookEvent {
  type: string;
  data: { object: unknown };
}
