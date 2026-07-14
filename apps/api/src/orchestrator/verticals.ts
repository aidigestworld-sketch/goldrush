export const ALLOWED_VERTICALS = ["shopify_subscriptions"] as const;
export type Vertical = (typeof ALLOWED_VERTICALS)[number];
