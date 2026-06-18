function parseDomains() {
  const rawDomains = process.env.EMAIL_DOMAINS || process.env.EMAIL_DOMAIN || "belfellah.tech";
  return rawDomains
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

const emailDomains = parseDomains();

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "0.0.0.0",
  emailDomain: emailDomains[0],
  emailDomains,
  dataFile: process.env.DATA_FILE || "data/db.json",
  storageDriver: process.env.STORAGE_DRIVER || "json",
  messagesPerAddress: Number(process.env.MESSAGES_PER_ADDRESS || 10),
  ingestSecret: process.env.INGEST_SECRET || "",
  dashboardToken: process.env.DASHBOARD_TOKEN || ""
};
