import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const listings = pgTable(
  "listings",
  {
    id: serial("id").primaryKey(),
    externalId: text("external_id").notNull(),
    price: text("price"),
    location: text("location"),
    link: text("link"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    externalIdIdx: uniqueIndex("listings_external_id_unique").on(table.externalId)
  })
);
