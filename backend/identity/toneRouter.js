// ============================================================
//  CORTÉX — TONE ROUTER (47.6E)
// ============================================================

export function resolveToneForNamespace(namespace = "root") {
  const map = {
    root: "king",              // KING namespace
    admin: "king",             // privileged
    advisory: "advisory",
    cybersecurity: "cybersecurity",
    recruiting: "recruiting",
    data: "dataManagement",
    dataManagement: "dataManagement",
    ventures: "ventures",
  };

  return map[namespace] || "king";  // fallback = KING authority
}
