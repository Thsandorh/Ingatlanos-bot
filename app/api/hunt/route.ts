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
const JINA_FALLBACK_BASE = "https://r.jina.ai/http://";

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

function extractPrice($node: Cheerio<AnyNode>) {
  const priceSelectors = [
    "[data-testid='listing-price']",
    "[data-test='listing-price']",
    "[data-testid='price']",
    ".price",
    "[class*='price']"
  ];

  for (const selector of priceSelectors) {
    const text = normalizeText($node.find(selector).first().text());
    if (text && /Ft|HUF|\d/.test(text)) {
      return text;
    }
  }

  const fallbackText = normalizeText($node.text());
  const match = fallbackText.match(/\b[\d\s\.]+\s?(Ft|HUF)\b/);
  return match?.[0] ?? "";
}

function extractLocation($node: Cheerio<AnyNode>) {
  const locationSelectors = [
    "[data-testid='listing-location']",
    "[data-test='listing-location']",
    ".listing__address",
    ".address",
    "[class*='location']"
  ];

  for (const selector of locationSelectors) {
    const text = normalizeText($node.find(selector).first().text());
    if (text) {
      return text;
    }
  }

  return "";
}

function extractListings(html: string): Listing[] {
  const $: CheerioAPI = cheerio.load(html);
  const listingsMap = new Map<string, Listing>();

  const attributeSelectors = [
    "[data-listing-id]",
    "[data-id]",
    "[data-ad-id]",
    "[data-adid]"
  ];

  for (const selector of attributeSelectors) {
    $(selector).each((_, element) => {
      const node = $(element);
      const rawId =
        node.attr("data-listing-id") ||
        node.attr("data-id") ||
        node.attr("data-ad-id") ||
        node.attr("data-adid") ||
        "";
      const anchor = node.find("a[href]").first();
      const href = toAbsoluteLink(anchor.attr("href") ?? "");
      const externalId = rawId || extractIdFromLink(href);

      if (!externalId || !href) {
        return;
      }

      listingsMap.set(externalId, {
        externalId,
        price: extractPrice(node),
        location: extractLocation(node),
        link: href
      });
    });
  }

  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const href = toAbsoluteLink(anchor.attr("href") ?? "");
    if (!href.includes("ingatlan.com")) {
      return;
    }

    const externalId = extractIdFromLink(href);
    if (!externalId || listingsMap.has(externalId)) {
      return;
    }

    const container = anchor.closest("article, section, div");
    listingsMap.set(externalId, {
      externalId,
      price: extractPrice(container),
      location: extractLocation(container),
      link: href
    });
  });

  if (listingsMap.size === 0) {
    const urlMatches = html.match(
      /(?:https?:\/\/)?(?:www\.)?ingatlan\.com\/\d+/gi
    ) ?? [];
    for (const rawMatch of urlMatches) {
      const normalizedMatch = rawMatch.startsWith("http")
        ? rawMatch
        : `https://${rawMatch.replace(/^\/\//, "")}`;
      const externalId = extractIdFromLink(normalizedMatch);
      if (!externalId || listingsMap.has(externalId)) {
        continue;
      }

      listingsMap.set(externalId, {
        externalId,
        price: "",
        location: "",
        link: normalizedMatch
      });
    }
  }

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
  const fallbackUrl = `${JINA_FALLBACK_BASE}${fallbackTarget}`;
  const fallbackResponse = await fetch(fallbackUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!fallbackResponse.ok) {
    return { html: "", via: "fallback", status: response.status };
  }

  return { html: await fallbackResponse.text(), via: "fallback" };
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
