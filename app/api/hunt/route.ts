import { NextResponse } from "next/server";
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { listings } from "@/db/schema";

export const runtime = "nodejs";

const SEARCH_URL =
  "https://ingatlan.com/szukites/elado+lakas+budapest+maganszemely";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const JINA_FALLBACK_BASES = [
  "https://r.jina.ai/https://",
  "https://r.jina.ai/http://"
];

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ??
  "8248269603:AAHpsX7jFFW0yJ9lHnpDiGIYU6gHP-rtTCI";
const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID ?? "6028176971";

type Listing = {
  externalId: string;
  price: string;
  location: string;
  link: string;
};

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function extractIdFromLink(link: string) {
  const absoluteMatch = link.match(/ingatlan\.com\/(\d+)/i);
  if (absoluteMatch?.[1]) {
    return absoluteMatch[1];
  }

  const relativeMatch = link.match(/^\/?(\d+)/);
  return relativeMatch?.[1] ?? "";
}

function toAbsoluteLink(href: string) {
  if (!href) {
    return "";
  }

  if (href.startsWith("http")) {
    return href;
  }

  if (href.startsWith("/")) {
    return `https://ingatlan.com${href}`;
  }

  return `https://ingatlan.com/${href}`;
}

function findListingsInNextData(nextData: unknown): Listing[] {
  const listingsMap = new Map<string, Listing>();
  const seen = new Set<unknown>();

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }

    if (seen.has(node)) {
      return;
    }

    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const record = node as Record<string, unknown>;
    const listingId =
      typeof record.listingId === "string"
        ? record.listingId
        : typeof record.listingId === "number"
          ? String(record.listingId)
          : "";
    const price =
      typeof record.price === "string"
        ? record.price
        : typeof record.price === "number"
          ? String(record.price)
          : "";
    const areaSize =
      typeof record.areaSize === "string"
        ? record.areaSize
        : typeof record.areaSize === "number"
          ? String(record.areaSize)
          : "";
    const location =
      typeof record.location === "string" ? record.location : "";
    const link =
      typeof record.url === "string"
        ? toAbsoluteLink(record.url)
        : listingId
          ? `https://ingatlan.com/${listingId}`
          : "";

    if (listingId) {
      listingsMap.set(listingId, {
        externalId: listingId,
        price,
        location: areaSize ? `${location} ${areaSize}`.trim() : location,
        link
      });
    }

    Object.values(record).forEach(visit);
  };

  visit(nextData);
  return Array.from(listingsMap.values());
}

function extractPriceFromText(text: string) {
  const match = text.match(/\b[\d\s,.]+\s?M\s?Ft\b/i);
  return match?.[0] ?? "";
}

function extractListings(html: string): Listing[] {
  const $: CheerioAPI = cheerio.load(html);
  const listingsMap = new Map<string, Listing>();

  const nextDataRaw = $("#__NEXT_DATA__").first().text().trim();
  if (nextDataRaw) {
    try {
      const nextData = JSON.parse(nextDataRaw) as unknown;
      for (const listing of findListingsInNextData(nextData)) {
        if (!listing.externalId) {
          continue;
        }
        listingsMap.set(listing.externalId, listing);
      }
    } catch {
      // ignore JSON parse failures and fall back to anchor scraping
    }
  }

  if (listingsMap.size > 0) {
    return Array.from(listingsMap.values());
  }

  $("a[href^='/hirdetes/'], a[href^='/szukites/']").each((_, element) => {
    const anchor = $(element);
    const href = toAbsoluteLink(anchor.attr("href") ?? "");
    const externalId = extractIdFromLink(href);
    if (!externalId || listingsMap.has(externalId)) {
      return;
    }

    const container = anchor.closest("article, section, div");
    const price = extractPriceFromText(normalizeText(container.text()));

    listingsMap.set(externalId, {
      externalId,
      price,
      location: "",
      link: href
    });
  });

  return Array.from(listingsMap.values());
}

async function sendTelegramMessage(message: string) {
  const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  await fetch(telegramUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: false
    })
  });
}

async function fetchSearchHtml() {
  const response = await fetch(SEARCH_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7",
      Referer: "https://ingatlan.com/",
      "Cache-Control": "no-cache"
    }
  });

  if (response.ok) {
    return { html: await response.text(), via: "direct" };
  }

  if (response.status !== 403) {
    return { html: "", via: "direct", status: response.status };
  }

  const fallbackTarget = SEARCH_URL.replace(/^https?:\/\//, "");

  for (const base of JINA_FALLBACK_BASES) {
    const fallbackUrl = `${base}${fallbackTarget}`;
    const fallbackResponse = await fetch(fallbackUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml"
      }
    });

    if (!fallbackResponse.ok) {
      continue;
    }

    const html = await fallbackResponse.text();
    if (html) {
      return { html, via: "fallback" };
    }
  }

  return { html: "", via: "fallback", status: response.status };
}

export async function GET() {
  const { html, via, status } = await fetchSearchHtml();

  if (!html) {
    return NextResponse.json(
      {
        ok: false,
        status: status ?? 500,
        message:
          status === 403
            ? "Failed to fetch ingatlan.com listings (403 blocked). Consider running from Vercel or adding a proxy."
            : "Failed to fetch ingatlan.com listings"
      },
      { status: status ?? 500 }
    );
  }

  const scrapedListings = extractListings(html);
  const newListings: Listing[] = [];

  for (const listing of scrapedListings) {
    const existing = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.externalId, listing.externalId))
      .limit(1);

    if (existing.length > 0) {
      continue;
    }

    await db.insert(listings).values({
      externalId: listing.externalId,
      price: listing.price,
      location: listing.location,
      link: listing.link
    });

    newListings.push(listing);

    const messageLines = [
      "New listing detected!",
      listing.price ? `Price: ${listing.price}` : "Price: n/a",
      listing.location ? `Location: ${listing.location}` : "Location: n/a",
      listing.link
    ];

    await sendTelegramMessage(messageLines.join("\n"));
  }

  return NextResponse.json({
    ok: true,
    scraped: scrapedListings.length,
    inserted: newListings.length,
    source: via
  });
}
