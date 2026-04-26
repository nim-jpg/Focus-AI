import { Router } from "express";

export const companiesHouseRouter = Router();

const API_BASE = "https://api.company-information.service.gov.uk";

interface CompanySearchHit {
  company_number?: string;
  title?: string;
  company_status?: string;
}

interface CompanyProfile {
  company_number?: string;
  company_name?: string;
  company_status?: string;
  date_of_creation?: string;
  confirmation_statement?: { next_due?: string; next_made_up_to?: string };
  accounts?: { next_due?: string; next_made_up_to?: string };
}

function authHeader(): string | null {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) return null;
  // Companies House uses HTTP Basic with the API key as username, blank password.
  const token = Buffer.from(`${key}:`).toString("base64");
  return `Basic ${token}`;
}

async function fetchProfile(companyNumber: string, auth: string): Promise<CompanyProfile | null> {
  const res = await fetch(`${API_BASE}/company/${encodeURIComponent(companyNumber)}`, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!res.ok) return null;
  return (await res.json()) as CompanyProfile;
}

companiesHouseRouter.get("/lookup", async (req, res) => {
  const auth = authHeader();
  if (!auth) {
    return res.status(503).json({
      error: "ch_not_configured",
      message: "COMPANIES_HOUSE_API_KEY missing in backend/.env",
    });
  }
  const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
  if (!name) return res.status(400).json({ error: "missing_name" });

  try {
    // Search returns the most relevant matches; we take the top active one.
    const search = await fetch(
      `${API_BASE}/search/companies?q=${encodeURIComponent(name)}&items_per_page=5`,
      { headers: { Authorization: auth, Accept: "application/json" } },
    );
    if (!search.ok) {
      return res
        .status(search.status)
        .json({ error: "ch_search_failed", message: `HTTP ${search.status}` });
    }
    const body = (await search.json()) as { items?: CompanySearchHit[] };
    const items = body.items ?? [];
    const best =
      items.find((i) => i.company_status === "active") ?? items[0];
    if (!best?.company_number) {
      return res.json({ found: false });
    }
    const profile = await fetchProfile(best.company_number, auth);
    if (!profile) return res.json({ found: false });

    res.json({
      found: true,
      company: {
        number: profile.company_number,
        name: profile.company_name,
        status: profile.company_status,
        incorporated: profile.date_of_creation,
      },
      confirmationStatement: {
        nextDue: profile.confirmation_statement?.next_due ?? null,
        nextMadeUpTo: profile.confirmation_statement?.next_made_up_to ?? null,
      },
      accounts: {
        nextDue: profile.accounts?.next_due ?? null,
        nextMadeUpTo: profile.accounts?.next_made_up_to ?? null,
      },
    });
  } catch (err) {
    res.status(500).json({
      error: "ch_request_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
