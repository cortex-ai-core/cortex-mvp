export function backendProvider(env = process.env) {
  const provider = env.BACKEND_PROVIDER || "supabase";
  if (!["supabase", "aws"].includes(provider)) throw new Error("BACKEND_PROVIDER must be supabase or aws.");
  return provider;
}

export function required(env, name, minimumLength = 1) {
  const value = env[name]?.trim();
  if (!value || value.length < minimumLength) throw new Error(`${name} is missing or too short.`);
  return value;
}

export function sessionConfig(env = process.env) {
  if (backendProvider(env) === "supabase") return { secret: required(env, "JWT_SECRET"), options: {} };
  return {
    secret: required(env, "AWS_CORTEX_JWT_SECRET", 32),
    options: { issuer: "cortex:aws", audience: "cortex:api" },
  };
}
