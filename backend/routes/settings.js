import userSettings from "./settings/UserSettings.js";
import organizationAdministration from "./settings/OrganizationAdministration.js";
import roleAdministration from "./settings/RoleAdministration.js";
import userManagement from "./settings/UserManagement.js";
import personaAdministration from "./settings/PersonaAdministration.js";
import retentionAdministration from "./settings/RetentionAdministration.js";

export default async function settingsRoutes(fastify) {
  await fastify.register(userSettings);
  await fastify.register(organizationAdministration);
  await fastify.register(roleAdministration);
  await fastify.register(userManagement);
  await fastify.register(personaAdministration);
  await fastify.register(retentionAdministration);
}
