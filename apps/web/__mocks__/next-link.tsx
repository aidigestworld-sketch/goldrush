// Minimal next/link stand-in for the jsdom test environment.
// The real Link does client-side navigation; here we just render an <a>.
import type { ComponentPropsWithoutRef } from "react";

type LinkProps = ComponentPropsWithoutRef<"a"> & { href: string };

export default function Link({ href, children, ...rest }: LinkProps) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
