/**
 * Product Input.
 *
 * Hardcoded test products for the Proof of Concept. Add entries to `PRODUCTS`,
 * then list whichever ones you want researched (in order) in `ACTIVE_PRODUCTS`.
 * `npm start` loops over that array, one full pipeline run per product.
 * No Shopify, no database — just an array.
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
  h2ohottub: {
    name: "H2O Hottubs 6000 Series 32A Twin Pump 6 Person",
    sku: "H2O6000SER",
    model: null,
    notes: "",
  },
  bromicheating: {
    name: "Bromic Heating Eclipse Smart-Heat™ Electric Portable",
    sku: "BH0820011",
    model: null,
    notes: "",
  },
  mark2scrambler: {
    name: "Mark2 Scrambler CL Mid Drive 90nm Torque Rockshox Suspension Electric Bike 250W",
    sku: "M1B1727K12",
    model:"",
    notes:""
  },
  eggreen:{
    name:"Ezego Trail Destroyer II Electric Mountain Bike 2025",
    sku:"EZE24-014-15-GREEN",
    model:"",
    notes:""
  }
} satisfies Record<string, ProductInput>;

/**
 * The products `npm start` researches, in order — one full pipeline run (and
 * one JSON report) per entry. Add/remove/reorder freely; each run costs its
 * own ~$0.04–$0.10 (see the usage/cost summary printed after each product).
 */
export const ACTIVE_PRODUCTS: ProductInput[] = [
  PRODUCTS.mark2scrambler,
  PRODUCTS.eggreen,
  PRODUCTS.bromicheating,
  PRODUCTS.h2ohottub
];
