/**
 * Product Input.
 *
 * Hardcoded test products for the Proof of Concept. Change `ACTIVE_PRODUCT`
 * to point at whichever entry you want to research, or add a new one.
 * No Shopify, no database — just an object.
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

export const PRODUCTS = {
  emuLongtail: {
    name: "EMU Longtail Electric Cargo Bike",
    sku: "CAR20BF",
    model: null,
    notes: "UK e-bike brand 'EMU'. Longtail cargo format.",
  },
  eleglideM2Mopride: {
    name: "Eleglide M2 Mopride Mountain E-Bike 250W",
    sku: null,
    model: "M2 Mopride",
    notes:
      "Must NOT be confused with: Eleglide M2 250W, Eleglide M2 Pro 500W, Eleglide M1.",
  },
} satisfies Record<string, ProductInput>;

/** The product the pipeline will research when you run `npm start`. */
export const ACTIVE_PRODUCT: ProductInput = PRODUCTS.emuLongtail;
