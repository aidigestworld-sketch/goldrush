declare global {
  namespace Express {
    interface Request {
      founderId: string;
    }
  }
}
export {};
