export interface CompaniesHouseAlternate {
  number: string;
  name: string;
  status: string;
}

export interface CompaniesHouseLookup {
  found: boolean;
  matchType?: "exact" | "fuzzy" | "explicit";
  alternates?: CompaniesHouseAlternate[];
  company?: {
    number: string;
    name: string;
    status: string;
    incorporated?: string;
  };
  confirmationStatement?: { nextDue: string | null; nextMadeUpTo: string | null };
  accounts?: { nextDue: string | null; nextMadeUpTo: string | null };
}

export class CompaniesHouseError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "CompaniesHouseError";
  }
}

export async function lookupCompany(
  nameOrNumber: { name?: string; number?: string },
): Promise<CompaniesHouseLookup> {
  const params = new URLSearchParams();
  if (nameOrNumber.name) params.set("name", nameOrNumber.name);
  if (nameOrNumber.number) params.set("number", nameOrNumber.number);
  const res = await fetch(`/api/companies-house/lookup?${params.toString()}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new CompaniesHouseError(
      body.message ?? `HTTP ${res.status}`,
      res.status,
    );
  }
  return (await res.json()) as CompaniesHouseLookup;
}

/**
 * Pull a likely UK company name out of free text. Looks for "X Ltd", "X Limited",
 * "X PLC", "X LLP" — captures up to 5 preceding words. Conservative — only matches
 * when the suffix is clearly present.
 */
export function extractCompanyName(text: string): string | null {
  const re = /\b([A-Z][A-Za-z0-9&'.\- ]{2,60}?\s+(?:Ltd|Limited|PLC|LLP))\b/;
  const match = text.match(re);
  if (!match) return null;
  return match[1].trim();
}
