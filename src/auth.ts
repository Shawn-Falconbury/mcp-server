import type { Request, Response, NextFunction } from 'express';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const expectedToken = process.env.MCP_TOKEN;

  if (!expectedToken) {
    console.error('[AUTH] MCP_TOKEN not configured');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  if (!authHeader) {
    console.warn(`[AUTH] Missing authorization header from ${req.ip}`);
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  const [type, token] = authHeader.split(' ');

  if (type !== 'Bearer' || token !== expectedToken) {
    console.warn(`[AUTH] Invalid token from ${req.ip}`);
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  console.log(`[AUTH] Authenticated request from ${req.ip}`);
  next();
}
