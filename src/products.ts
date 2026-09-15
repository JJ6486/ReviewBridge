/**
 * Product Input.
 *
 * The web UI (public/index.html → POST /api/research) is the only way products
 * get submitted now — there's no hardcoded product list or CLI entrypoint.
 * This file just holds the shared shape every product goes through the
 * pipeline as.
 */

export interface ProductInput {
  /** Human-readable name exactly as the requester provided it. */
  name: string;
  /** Retailer SKU, if known. */
  sku: string | null;
  /** Manufacturer model number, if known. */
  model: string | null;
  /** Optional free-text hint to help the agent disambiguate. */
  notes?: string;
}
