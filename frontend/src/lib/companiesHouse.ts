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
 * "X PLC", "X LLP". Only walks backwards through *contiguous capitalised words*
 * — stops at a lowercase filler ("for", "of", "from") so it doesn't grab the
 * whole phrase "File confirmation statement for Elyxir Ltd" as the name.
 */
export function extractCompanyName(text: string): string | null {
  // Allow very small connector words inside the name (e.g. "Marks and Spencer plc")
  // by lowercasing only "and", "of", "&" between Capitalised tokens.
  const tokenChars = "[A-Za-z0-9&'.\\-]+";
  const cap = `[A-Z]${tokenChars.slice(1)}`;
  const connector = "(?:and|of|&)";
  const namePart = `${cap}(?:\\s+(?:${cap}|${connector}))*`;
  const suffix = "(?:Ltd|Limited|PLC|LLP)";
  const re = new RegExp(`\\b(${namePart})\\s+${suffix}\\b`);
  const match = text.match(re);
  if (!match) return null;
  // Re-attach the suffix from the original match so the caller gets "Foo Ltd".
  const fullMatch = match[0];
  return fullMatch.trim();
}
