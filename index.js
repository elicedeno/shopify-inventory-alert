/**
 * Shopify Inventory Alert System
 * Monitors product variant stock levels and sends email alerts via Gmail SMTP.
 *
 * Usage:
 *   node index.js          → starts the cron job (runs daily at 8 AM)
 *   node index.js --test   → runs a one-off inventory check immediately and exits
 */

import "dotenv/config";
import { createAdminApiClient } from "@shopify/admin-api-client";
import nodemailer from "nodemailer";
import cron from "node-cron";

// ─── Config ──────────────────────────────────────────────────────────────────

const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD ?? "10", 10);
const TEST_MODE = process.argv.includes("--test");

// Validate required env vars at startup so we fail fast with a clear message.
const REQUIRED_ENV = [
  "SHOPIFY_STORE_DOMAIN",
  "SHOPIFY_ACCESS_TOKEN",
  "SHOPIFY_API_VERSION",
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "ALERT_EMAIL_TO",
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌  Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ─── Shopify client ───────────────────────────────────────────────────────────

const shopify = createAdminApiClient({
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
  apiVersion: process.env.SHOPIFY_API_VERSION,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
});

// ─── Nodemailer transporter ───────────────────────────────────────────────────

// Gmail requires an App Password (not your normal Gmail password).
// Generate one at: https://myaccount.google.com/apppasswords
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ─── GraphQL helpers ──────────────────────────────────────────────────────────

/**
 * Fetches all product variants with inventory levels, handling pagination.
 * Shopify's Admin API returns at most 250 items per page, so we walk the
 * cursor-based `pageInfo.endCursor` until `hasNextPage` is false.
 *
 * @returns {Promise<Array>} Flat array of variant objects with stock data.
 */
async function fetchAllVariants() {
  // `available` was deprecated on InventoryLevel in API 2025-07.
  // The replacement is quantities(names: ["available"]), which returns
  // an array of { name, quantity } objects. We filter to "available" in
  // the JS processing below rather than assuming array index [0].
  //
  // PAGE SIZE NOTE: Shopify calculates query cost as the product of all
  // nested connection limits. The hard cap is 1000 points per query.
  //   products(10) x variants(10) x inventoryLevels(5) = 500 points ✓
  // Increasing any of these multiplies cost fast — keep the product <= 1000.
  const QUERY = /* GraphQL */ `
    query GetVariants($cursor: String) {
      products(first: 10, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  sku
                  inventoryItem {
                    id
                    inventoryLevels(first: 5) {
                      edges {
                        node {
                          quantities(names: ["available"]) {
                            name
                            quantity
                          }
                          location {
                            name
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const allVariants = [];
  let cursor = null;
  let page = 1;

  // Keep fetching pages until Shopify tells us there are no more.
  while (true) {
    console.log(`📦  Fetching product page ${page}${cursor ? ` (cursor: ${cursor.slice(0, 12)}…)` : ""}…`);

    const { data, errors } = await shopify.request(QUERY, {
      variables: { cursor },
    });

    if (errors) {
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(errors)}`);
    }

    const { edges, pageInfo } = data.products;

    for (const { node: product } of edges) {
      for (const { node: variant } of product.variants.edges) {
        // Sum inventory across all locations for this variant.
        // Stores often have a single location, but multi-location stores exist.
        const levels = variant.inventoryItem?.inventoryLevels?.edges ?? [];

        // quantities is an array like [{ name: "available", quantity: 5 }].
        // We find the "available" entry explicitly — future API versions may
        // return additional named quantities (e.g. "committed", "on_hand") in
        // the same array, so never assume index [0] is always "available".
        const getAvailable = (quantitiesArr) => {
          const entry = (quantitiesArr ?? []).find((q) => q.name === "available");
          return entry?.quantity ?? 0;
        };

        const totalAvailable = levels.reduce(
          (sum, { node: level }) => sum + getAvailable(level.quantities),
          0
        );

        allVariants.push({
          productId: product.id,
          productTitle: product.title,
          variantId: variant.id,
          variantTitle: variant.title,
          sku: variant.sku || "—",
          quantity: totalAvailable,
          // Keep individual location breakdown for richer email context.
          locations: levels.map(({ node: l }) => ({
            name: l.location.name,
            available: getAvailable(l.quantities),
          })),
        });
      }
    }

    if (!pageInfo.hasNextPage) break;

    cursor = pageInfo.endCursor;
    page++;

    // Small delay between pages to be a good API citizen (avoids rate limiting).
    await sleep(300);
  }

  console.log(`✅  Fetched ${allVariants.length} variants across ${page} page(s).`);
  return allVariants;
}

// ─── Inventory analysis ───────────────────────────────────────────────────────

/**
 * Splits variants into two buckets:
 *   outOfStock  → quantity === 0  (triggers an immediate alert)
 *   lowStock    → 0 < quantity < threshold  (included in daily digest)
 */
function analyzeInventory(variants) {
  const outOfStock = [];
  const lowStock = [];

  for (const v of variants) {
    if (v.quantity === 0) {
      outOfStock.push(v);
    } else if (v.quantity < LOW_STOCK_THRESHOLD) {
      lowStock.push(v);
    }
  }

  // Sort by quantity ascending so the most critical items appear first.
  outOfStock.sort((a, b) => a.productTitle.localeCompare(b.productTitle));
  lowStock.sort((a, b) => a.quantity - b.quantity);

  return { outOfStock, lowStock };
}

// ─── Email builders ───────────────────────────────────────────────────────────

/**
 * Returns a full HTML email body for the daily digest.
 * Both lowStock and outOfStock items are included in the summary.
 */
function buildDailyDigestHtml({ lowStock, outOfStock }) {
  const allItems = [...outOfStock, ...lowStock];

  if (allItems.length === 0) {
    return `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <h2 style="color:#2c3e50;">✅ All Inventory Levels Are Healthy</h2>
        <p>No variants are below the threshold of <strong>${LOW_STOCK_THRESHOLD} units</strong> as of ${timestamp()}.</p>
      </div>`;
  }

  const rows = allItems
    .map((v) => {
      const qtyColor = v.quantity === 0 ? "#e74c3c" : v.quantity <= 5 ? "#e67e22" : "#f39c12";
      const qtyLabel = v.quantity === 0 ? "OUT OF STOCK" : v.quantity;
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #ecf0f1;">${v.productTitle}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ecf0f1;">${v.variantTitle}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ecf0f1;color:#7f8c8d;font-size:13px;">${v.sku}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ecf0f1;text-align:center;">
            <span style="background:${qtyColor};color:#fff;padding:3px 10px;border-radius:12px;font-weight:bold;font-size:13px;">${qtyLabel}</span>
          </td>
        </tr>`;
    })
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:20px;color:#2c3e50;">
      <h2 style="border-bottom:3px solid #e74c3c;padding-bottom:8px;">🔔 Daily Inventory Alert — ${timestamp()}</h2>
      <p>The following <strong>${allItems.length} variant(s)</strong> are at or below the threshold of <strong>${LOW_STOCK_THRESHOLD} units</strong>:</p>

      <table style="width:100%;border-collapse:collapse;margin-top:16px;">
        <thead>
          <tr style="background:#f8f9fa;">
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #dee2e6;">Product</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #dee2e6;">Variant</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #dee2e6;">SKU</th>
            <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #dee2e6;">Qty</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <p style="margin-top:24px;font-size:13px;color:#95a5a6;">
        Sent by Shopify Inventory Alert · Threshold: ${LOW_STOCK_THRESHOLD} units<br>
        Store: ${process.env.SHOPIFY_STORE_DOMAIN}
      </p>
    </div>`;
}

/**
 * Returns a concise HTML alert for a single out-of-stock item.
 * Sent immediately when a variant hits 0 (in addition to the daily digest).
 */
function buildOutOfStockAlertHtml(variant) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#2c3e50;">
      <h2 style="color:#e74c3c;">🚨 Out-of-Stock Alert — Immediate Action Required</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:8px 0;font-weight:bold;width:140px;">Product</td><td>${variant.productTitle}</td></tr>
        <tr><td style="padding:8px 0;font-weight:bold;">Variant</td><td>${variant.variantTitle}</td></tr>
        <tr><td style="padding:8px 0;font-weight:bold;">SKU</td><td>${variant.sku}</td></tr>
        <tr><td style="padding:8px 0;font-weight:bold;">Quantity</td><td><strong style="color:#e74c3c;">0 — OUT OF STOCK</strong></td></tr>
        ${
          variant.locations.length > 1
            ? `<tr><td style="padding:8px 0;font-weight:bold;vertical-align:top;">Locations</td><td>${variant.locations.map((l) => `${l.name}: ${l.available}`).join("<br>")}</td></tr>`
            : ""
        }
      </table>
      <p style="margin-top:20px;font-size:13px;color:#95a5a6;">Detected at ${timestamp()} · Store: ${process.env.SHOPIFY_STORE_DOMAIN}</p>
    </div>`;
}

// ─── Email sending ────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, html }) {
  const info = await transporter.sendMail({
    from: `"Inventory Alerts" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
  });
  console.log(`📧  Email sent → ${subject} [messageId: ${info.messageId}]`);
}

// ─── Main check ───────────────────────────────────────────────────────────────

/**
 * The core routine:
 *   1. Pull all variants from Shopify
 *   2. Identify low-stock and out-of-stock items
 *   3. Fire immediate alerts for any out-of-stock variant
 *   4. Send the daily digest (even if stock is healthy — so you know it ran)
 */
async function runInventoryCheck() {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`🏁  Starting inventory check at ${timestamp()}`);
  console.log(`    Threshold: ${LOW_STOCK_THRESHOLD} units | Store: ${process.env.SHOPIFY_STORE_DOMAIN}`);
  console.log("─".repeat(60));

  try {
    const variants = await fetchAllVariants();
    const { outOfStock, lowStock } = analyzeInventory(variants);

    console.log(`📊  Results → Out of stock: ${outOfStock.length} | Low stock: ${lowStock.length}`);

    // ── Immediate out-of-stock alerts ─────────────────────────────────────────
    // Send one email per variant so the subject line is actionable and specific.
    if (outOfStock.length > 0) {
      console.log(`🚨  Sending ${outOfStock.length} out-of-stock alert(s)…`);
      for (const variant of outOfStock) {
        await sendEmail({
          to: process.env.ALERT_EMAIL_TO,
          subject: `🚨 OUT OF STOCK: ${variant.productTitle} — ${variant.variantTitle}`,
          html: buildOutOfStockAlertHtml(variant),
        });
      }
    }

    // ── Daily digest ──────────────────────────────────────────────────────────
    // Always send the digest (even when everything is fine) so you have a paper
    // trail confirming the job ran. If you only want it when there are issues,
    // wrap this in `if (outOfStock.length + lowStock.length > 0)`.
    const digestSubject =
      outOfStock.length + lowStock.length === 0
        ? `✅ Inventory Healthy — Daily Report ${dateString()}`
        : `⚠️ ${outOfStock.length + lowStock.length} Low-Stock Items — Daily Report ${dateString()}`;

    await sendEmail({
      to: process.env.ALERT_EMAIL_TO,
      subject: digestSubject,
      html: buildDailyDigestHtml({ lowStock, outOfStock }),
    });

    console.log(`✅  Inventory check complete.\n`);
  } catch (err) {
    // Log the full error but don't let it crash the process — the cron job
    // should keep running even if one check fails.
    console.error("❌  Inventory check failed:", err.message);
    console.error(err.stack);

    // Optionally send a failure notification so you know the job errored.
    try {
      await sendEmail({
        to: process.env.ALERT_EMAIL_TO,
        subject: `❌ Inventory Check Failed — ${timestamp()}`,
        html: `<p>The inventory check encountered an error:</p><pre>${err.message}\n\n${err.stack}</pre>`,
      });
    } catch (mailErr) {
      console.error("❌  Also failed to send error notification:", mailErr.message);
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (TEST_MODE) {
  // --test flag: run immediately and exit. Useful for CI, debugging, and first-run validation.
  console.log("🧪  TEST MODE — running inventory check now (skipping cron schedule)…");
  runInventoryCheck().then(() => process.exit(0));
} else {
  // Production mode: schedule at 8:00 AM every day in the configured timezone.
  // See https://crontab.guru/ if you want a different schedule.
  const timezone = process.env.CRON_TIMEZONE ?? "America/New_York";
  console.log(`⏰  Cron scheduled → daily at 08:00 (${timezone}). Waiting…`);

  cron.schedule("0 8 * * *", runInventoryCheck, { timezone });

  // Keep the process alive (required on Railway / any persistent host).
  // Without this, the script would exit immediately after setting up the cron.
  process.on("SIGTERM", () => {
    console.log("👋  SIGTERM received — shutting down gracefully.");
    process.exit(0);
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}

function dateString() {
  return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
