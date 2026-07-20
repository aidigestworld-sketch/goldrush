export const ALLOWED_VERTICALS = [
  "shopify_subscriptions",
  "b2b_customer_support_saas",
] as const;
export type Vertical = (typeof ALLOWED_VERTICALS)[number];
