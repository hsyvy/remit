import { toCents } from "../money.ts";

export interface Product {
  id: string;
  title: string;
  brand?: string;
  priceCents: number;
  currency: string;
  merchant: string;
  url: string;
  image?: string;
  inStock: boolean;
}

export interface ProductSearch {
  readonly source: "channel3" | "demo";
  search(query: string, opts?: { maxPriceCents?: number; limit?: number }): Promise<Product[]>;
}

/** Channel3 v1 search: POST https://api.trychannel3.com/v1/search */
export class Channel3Search implements ProductSearch {
  readonly source = "channel3" as const;

  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: { maxPriceCents?: number; limit?: number } = {}) {
    const res = await fetch("https://api.trychannel3.com/v1/search", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        limit: Math.min(opts.limit ?? 6, 30),
        filters: {
          availability: ["InStock"],
          ...(opts.maxPriceCents ? { price: { max_price: opts.maxPriceCents / 100 } } : {}),
        },
        config: { currency: "USD", country: "US" },
      }),
    });
    if (!res.ok) throw new Error(`Channel3 search failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { products: Channel3Product[] };
    const products: Product[] = [];
    for (const p of body.products ?? []) {
      // A product can be sold by several stores. Take the cheapest in-stock USD offer.
      const offer = (p.offers ?? [])
        .filter((o) => o.price?.currency === "USD")
        .sort((a, b) => Number(b.availability === "InStock") - Number(a.availability === "InStock") || a.price.price - b.price.price)[0];
      if (!offer) continue;
      products.push({
        id: p.id,
        title: p.title,
        brand: p.brands?.[0]?.name,
        priceCents: toCents(offer.price.price),
        currency: offer.price.currency,
        merchant: offer.domain,
        url: offer.url,
        image: p.images?.find((i) => i.is_main_image)?.url ?? p.images?.[0]?.url,
        inStock: offer.availability === "InStock",
      });
    }
    return products;
  }
}

interface Channel3Product {
  id: string;
  title: string;
  brands?: { name: string }[];
  images?: { url: string; is_main_image?: boolean }[];
  offers?: { url: string; domain: string; availability: string; price: { price: number; currency: string } }[];
}

/**
 * A small fixed catalog for running without a Channel3 key. Results say `merchant: "demo catalog"`
 * so nobody mistakes them for live prices.
 */
export class DemoSearch implements ProductSearch {
  readonly source = "demo" as const;

  async search(query: string, opts: { maxPriceCents?: number; limit?: number } = {}) {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const scored = DEMO_CATALOG.map((p) => ({
      p,
      score: words.filter((w) => `${p.title} ${p.tags}`.toLowerCase().includes(w)).length,
    }))
      .filter((s) => s.score > 0 && (!opts.maxPriceCents || s.p.priceCents <= opts.maxPriceCents))
      .sort((a, b) => b.score - a.score || a.p.priceCents - b.p.priceCents);
    return scored.slice(0, opts.limit ?? 6).map(({ p }) => ({
      id: p.id,
      title: p.title,
      brand: p.brand,
      priceCents: p.priceCents,
      currency: "USD",
      merchant: "demo catalog",
      url: `https://example.com/demo/${p.id}`,
      inStock: true,
    }));
  }
}

const DEMO_CATALOG = [
  { id: "demo-dogfood-12kg", title: "Adult Chicken & Rice Dry Dog Food, 12 kg bag", brand: "Hillcrest", priceCents: 3249, tags: "dog food kibble pet" },
  { id: "demo-dogfood-6kg", title: "Adult Chicken & Rice Dry Dog Food, 6 kg bag", brand: "Hillcrest", priceCents: 1899, tags: "dog food kibble pet" },
  { id: "demo-dogfood-grainfree", title: "Grain-Free Salmon Dry Dog Food, 11 kg bag", brand: "Northbay", priceCents: 5499, tags: "dog food kibble pet salmon" },
  { id: "demo-groceries-staples", title: "Weekly grocery order: produce, dairy, bread, eggs", brand: "FreshCart", priceCents: 4185, tags: "groceries grocery food weekly produce" },
  { id: "demo-groceries-pantry", title: "Pantry restock: rice, pasta, oil, canned beans", brand: "FreshCart", priceCents: 3620, tags: "groceries grocery pantry food" },
  { id: "demo-coffee", title: "Whole Bean Coffee, Medium Roast, 1 kg", brand: "Ridgeline", priceCents: 2450, tags: "coffee beans groceries" },
  { id: "demo-gift-headphones", title: "Wireless Over-Ear Headphones, Noise Cancelling", brand: "Aurel", priceCents: 9500, tags: "gift birthday headphones music electronics" },
  { id: "demo-gift-book", title: "Illustrated Field Guide to Birds (Hardcover)", brand: "Wren Press", priceCents: 2899, tags: "gift birthday book birds nature" },
  { id: "demo-gift-mug", title: "Hand-Thrown Ceramic Mug Set of 2", brand: "Kiln & Co", priceCents: 3400, tags: "gift birthday mug ceramic coffee" },
  { id: "demo-gift-plant", title: "Potted Monstera with Ceramic Planter", brand: "Greenhouse", priceCents: 3900, tags: "gift birthday plant home" },
  { id: "demo-gift-puzzle", title: "1000-Piece Jigsaw Puzzle, Mountain Lake", brand: "Piecewise", priceCents: 2200, tags: "gift birthday puzzle game" },
  { id: "demo-paper-towels", title: "Paper Towels, 12 Double Rolls", brand: "Softleaf", priceCents: 2299, tags: "household paper towels cleaning" },
  { id: "demo-detergent", title: "Laundry Detergent, 96 loads", brand: "Brightwash", priceCents: 1999, tags: "household laundry detergent cleaning" },
];
