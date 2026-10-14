import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { backendProvider, required } from "./config.js";

export function createAuthenticationService(database, env = process.env, dependencies = {}) {
  if (backendProvider(env) === "supabase") {
    const anonKey = env.SUPABASE_ANON_KEY?.trim() || required(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");
    const client = createClient(required(env, "SUPABASE_URL"), anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: dependencies.fetch || globalThis.fetch },
    });
    return {
      async signInWithPassword(credentials) {
        const { data, error } = await client.auth.signInWithPassword(credentials);
        return { data, error: error ? { status: 401, message: "Invalid credentials." } : null };
      },
      admin: database.auth.admin,
      profileColumn: "auth_user_id", legacyAuthId: (id) => id,
      linkUser: async () => {},
    };
  }

  const userPoolId = required(env, "COGNITO_USER_POOL_ID");
  const clientId = required(env, "COGNITO_CLIENT_ID");
  const region = env.AWS_REGION || "us-east-2";
  if (!/^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/.test(userPoolId) || !userPoolId.startsWith(`${region}_`)) {
    throw new Error("COGNITO_USER_POOL_ID must belong to AWS_REGION.");
  }
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  const endpoint = `https://cognito-idp.${region}.amazonaws.com/`;
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const idVerifier = dependencies.idVerifier || CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "id" });
  const accessVerifier = dependencies.accessVerifier || CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" });
  const adminClient = dependencies.adminClient || new CognitoIdentityProviderClient({ region });
  const invalid = () => ({ data: { user: null }, error: { message: "Invalid credentials.", status: 401 } });

  return {
    profileColumn: "id", legacyAuthId: () => null,
    async signInWithPassword({ email, password }) {
      const parameters = { USERNAME: email, PASSWORD: password };
      if (env.COGNITO_CLIENT_SECRET) parameters.SECRET_HASH = createHmac("sha256", env.COGNITO_CLIENT_SECRET)
        .update(email + clientId).digest("base64");
      // InitiateAuth does not require IAM credentials; the client secret stays on the backend.
      const response = await fetchImpl(endpoint, {
        method: "POST", signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth" },
        body: JSON.stringify({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: clientId, AuthParameters: parameters }),
      });
      const result = await response.json();
      if (!response.ok) {
        const name = String(result.__type || "").split("#").pop();
        if (["NotAuthorizedException", "UserNotFoundException", "UserNotConfirmedException", "PasswordResetRequiredException"].includes(name)) return invalid();
        throw new Error("Cognito sign-in service is unavailable or misconfigured.");
      }
      if (result.ChallengeName) return {
        data: { user: null }, error: { status: 403, message: "Complete the required Cognito password change or sign-in challenge before using this login." },
      };
      const tokens = result.AuthenticationResult;
      if (!tokens?.IdToken || !tokens.AccessToken) return invalid();
      let id, access;
      try {
        [id, access] = await Promise.all([idVerifier.verify(tokens.IdToken), accessVerifier.verify(tokens.AccessToken)]);
      } catch { return invalid(); }
      if (id.sub !== access.sub || id.email_verified !== true || id.email?.toLowerCase() !== email.toLowerCase()) return invalid();
      const { data: link, error } = await database.from("auth_identities").select("user_id")
        .eq("provider", "cognito").eq("issuer", issuer).eq("subject", id.sub).maybeSingle();
      if (error) throw new Error("Unable to resolve the Cognito identity link.");
      if (!link) return { data: { user: null }, error: { status: 403, message: "Account is not linked to a Cortéx profile." } };
      return { data: { user: { id: link.user_id } }, error: null };
    },
    async linkUser(subject, userId) {
      const { error } = await database.from("auth_identities").insert({ provider: "cognito", issuer, subject, user_id: userId });
      if (error) throw new Error("Unable to link the new Cognito user.");
    },
    admin: {
      async createUser({ email, password }) {
        let createdUsername;
        try {
          const result = await adminClient.send(new AdminCreateUserCommand({
            UserPoolId: userPoolId, Username: email, MessageAction: "SUPPRESS",
            UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
          }));
          createdUsername = result.User?.Username;
          const subject = result.User?.Attributes?.find((attribute) => attribute.Name === "sub")?.Value;
          if (!createdUsername || !subject) throw new Error("Cognito did not return a user identity.");
          await adminClient.send(new AdminSetUserPasswordCommand({
            UserPoolId: userPoolId, Username: createdUsername, Password: password, Permanent: true,
          }));
          return { data: { user: { id: subject } }, error: null };
        } catch (error) {
          if (createdUsername) {
            try { await adminClient.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: createdUsername })); }
            catch { throw new Error("Cognito user provisioning failed; manual cleanup of the new account is required."); }
          }
          const message = error.name === "UsernameExistsException" ? "An account with this email already exists." : "Unable to create Cognito user. Check password policy and AWS permissions.";
          return { data: { user: null }, error: { message } };
        }
      },
      async deleteUser(subject) {
        try {
          await adminClient.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: subject }));
          return { data: null, error: null };
        } catch { return { data: null, error: { message: "Unable to remove the new Cognito account." } }; }
      },
    },
  };
}
