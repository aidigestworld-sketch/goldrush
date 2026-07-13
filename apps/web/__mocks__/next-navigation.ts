// Stub for next/navigation hooks used in the jsdom test environment.
export const useRouter = () => ({ push: () => {}, replace: () => {}, back: () => {} });
export const usePathname = () => "/";
export const useSearchParams = () => new URLSearchParams();
// redirect() throws in the real Next.js runtime; tests that need to assert on
// it should override via vi.mock("next/navigation", ...) in the test file.
export const redirect = (url: string): never => {
  throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT", url });
};
