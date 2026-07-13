import { type Request, type Response, type NextFunction } from "express";
import { prisma } from "../db/client";
import { supabaseAdmin } from "../lib/supabaseAdmin";

// Verifies a JWT string and returns the Supabase user id, or null on failure.
// Injectable so tests can substitute a fake without touching the DB.
export type JwtVerifier = (jwt: string) => Promise<string | null>;

export const defaultVerifyJwt: JwtVerifier = async (jwt) => {
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !user) return null;
  return user.id;
};

export function makeAuthMiddleware(verifyJwt: JwtVerifier = defaultVerifyJwt) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization ?? "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!jwt) {
      res.status(401).json({ error: "missing token" });
      return;
    }

    const userId = await verifyJwt(jwt);
    if (!userId) {
      res.status(401).json({ error: "invalid token" });
      return;
    }

    const founder = await prisma.founder.findUnique({
      where: { authUserId: userId },
      select: { id: true },
    });
    if (!founder) {
      res.status(401).json({ error: "no founder account" });
      return;
    }

    req.founderId = founder.id;
    next();
  };
}
