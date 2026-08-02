export const DEVELOPMENT_JWT_SECRET = "steadio-dev-secret-change-in-prod";

export function getJwtSecret(): string {
  const jwtSecret = process.env["JWT_SECRET"];
  const isProduction = process.env["NODE_ENV"] === "production";

  if (isProduction && (!jwtSecret || jwtSecret === DEVELOPMENT_JWT_SECRET)) {
    throw new Error(
      "JWT_SECRET must be set to a non-development value when NODE_ENV=production",
    );
  }

  return jwtSecret ?? DEVELOPMENT_JWT_SECRET;
}
