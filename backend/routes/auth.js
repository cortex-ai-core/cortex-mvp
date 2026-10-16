import jwt from "jsonwebtoken";
import { sessionConfig } from "../lib/services/config.js";

const slug = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";

export default async function authRoutes(fastify) {
  const auth = fastify.authentication;
  const session = sessionConfig();
  fastify.post('/api/auth/password-reset/request', async (req,reply) => {
    const email=slug(req.body?.email);
    if(!email||email.length>320||!email.includes('@'))return reply.code(400).send({error:'Enter a valid email address.'});
    if(!auth.requestPasswordReset)return reply.code(501).send({error:'Contact your administrator to reset your password.'});
    try{await auth.requestPasswordReset(email);return {message:'If your account is eligible, a reset code will be sent to your email.'};}
    catch{return reply.code(503).send({error:'Unable to request a reset. Try again later.'});}
  });
  fastify.post('/api/auth/password-reset/confirm', async (req,reply) => {
    const email=slug(req.body?.email),code=String(req.body?.code||'').trim(),password=req.body?.password;
    if(!email||email.length>320||!/^\d{6}$/.test(code)||typeof password!=='string'||password.length<12||password.length>256)return reply.code(400).send({error:'Enter your email, six-digit code, and a password of at least 12 characters.'});
    if(!auth.confirmPasswordReset)return reply.code(501).send({error:'Contact your administrator.'});
    try{await auth.confirmPasswordReset(email,code,password);return {message:'Password updated. You can sign in now.'};}
    catch{return reply.code(400).send({error:'The code or password was not accepted. Check the code and password policy.'});}
  });

  // POST /api/auth/login
  // Authenticates with the configured provider, loads the matching
  // application role, organization, and namespace memberships, then issues
  // the Cortéx JWT consumed by the frontend and protected API routes.
  fastify.post("/api/auth/login", async (req, reply) => {
    const body = req.body || {};
    let email = slug(body.email || body.username);
    let challengeSession,challengeUsername;
    if(body.challengeToken){
      try{const challenge=jwt.verify(body.challengeToken,session.secret,{issuer:"cortex:password-change",audience:"cortex:password-change"});email=challenge.email;challengeSession=challenge.session;challengeUsername=challenge.username;}
      catch{return reply.code(401).send({error:"Your password-change session expired. Sign in again."});}
      if(typeof body.newPassword!=="string"||body.newPassword.length<12||body.newPassword.length>256)return reply.code(400).send({error:"Choose a password of at least 12 characters."});
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || (!password&&!challengeSession)) {
      return reply.code(400).send({ error: "Email and password are required." });
    }

    try {
      const { data, error } = await auth.signInWithPassword({ email, password,challengeSession,challengeUsername,newPassword:body.newPassword });
      if(data?.challenge){
        const challengeToken=jwt.sign({email,session:data.challenge.session,username:data.challenge.username},session.secret,{issuer:'cortex:password-change',audience:'cortex:password-change',expiresIn:'5m'});
        return {challenge:'NEW_PASSWORD_REQUIRED',challengeToken};
      }
      if (error || !data.user) {
        return reply.code(error?.status || 401).send({ error: error?.message || "Invalid credentials." });
      }

      const { data: profile, error: profileError } = await fastify.supabase
        .from("user")
        .select(`
          id, auth_user_id, email, active,
          role:role_id(id,name),
          organization:organization_id(id,name)
        `)
        .eq(auth.profileColumn, data.user.id)
        .maybeSingle();
      if (profileError) throw profileError;
      if (!profile?.active || !profile.role || !profile.organization) {
        return reply.code(403).send({ error: "Account is not authorized for Cortéx." });
      }

      const { data: memberships, error: membershipError } = await fastify.supabase
        .from("namespace_users")
        .select("namespace:namespace_id(id,name,organization_id)")
        .eq("user_id", profile.id)
        .order("created_at", { ascending: true });
      if (membershipError) throw membershipError;

      const namespaceRecords = (memberships || [])
        .map((membership) => membership.namespace)
        .filter((item) => item?.organization_id === profile.organization.id);
      const namespaceNames = namespaceRecords.map((item) => slug(item.name));
      const namespaceIds = namespaceRecords.map((item) => item.id);
      if (!namespaceIds.length) {
        return reply.code(403).send({ error: "Account has no authorized namespace." });
      }

      // The namespace id is the only key. A caller may pick one by id
      // (preferred) or, for older clients, by name; otherwise the first
      // membership is used.
      const requestedId = typeof body.namespaceId === "string" ? body.namespaceId.trim() : "";
      const requestedName = slug(body.namespace);
      let selected = null;
      if (requestedId) selected = namespaceRecords.find((item) => item.id === requestedId) || null;
      else if (requestedName) selected = namespaceRecords.find((item) => slug(item.name) === requestedName) || null;
      else selected = namespaceRecords[0];
      if (!selected) {
        return reply.code(403).send({ error: "Namespace access denied." });
      }

      const organizations = [{
        id: profile.organization.id,
        name: profile.organization.name,
        namespaces: namespaceRecords.map(({ id, name }) => ({ id, name })),
      }];
      const claims = {
        userId: profile.id,
        email: profile.email,
        role: profile.role.name,
        organization: profile.organization.name,
        organizationId: profile.organization.id,
        namespaceId: selected.id,
        namespace: selected.name,        // display only; never a lookup key
        namespaces: namespaceIds,
        organizations,
      };

      return {
        token: jwt.sign(claims, session.secret, { expiresIn: "7d", ...session.options }),
        user: { ...claims, namespaceNames },
      };
    } catch (err) {
      req.log.error({ err }, "Login failed");
      return reply.code(500).send({ error: "Login failed." });
    }
  });
}
