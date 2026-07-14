import Stripe from "stripe";
import type { StripeClient } from "./types";

let _stripe: Stripe | null = null;

export function getStripe(): StripeClient {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not set");
    _stripe = new Stripe(key);
  }
  return _stripe as unknown as StripeClient;
}
