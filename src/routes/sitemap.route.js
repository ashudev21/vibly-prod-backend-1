import express from "express";
import Product from "../models/product.model.js";
import Category from "../models/category.model.js";
import logger from "../utils/logger.js";

const router = express.Router();

const SITE_URL = "https://vibly.in";

const staticPages = [
  { loc: `${SITE_URL}/`, changefreq: "daily", priority: "1.0" },
  { loc: `${SITE_URL}/products`, changefreq: "daily", priority: "0.9" },
  { loc: `${SITE_URL}/sizes`, changefreq: "monthly", priority: "0.6" },
  { loc: `${SITE_URL}/terms-and-conditions`, changefreq: "monthly", priority: "0.4" },
  { loc: `${SITE_URL}/privacy-policy`, changefreq: "monthly", priority: "0.4" },
  { loc: `${SITE_URL}/refund`, changefreq: "monthly", priority: "0.4" },
  { loc: `${SITE_URL}/shipping`, changefreq: "monthly", priority: "0.4" },
];

function buildUrlEntry({ loc, changefreq, priority, lastmod }) {
  return `  <url>
    <loc>${loc}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

/**
 * @route  GET /sitemap.xml
 * @desc   Dynamic XML sitemap with static pages + live products & categories
 * @access Public
 */
router.get("/sitemap.xml", async (req, res) => {
  try {
    // Fetch active products and categories in parallel
    const [products, categories] = await Promise.all([
      Product.find({ isActive: true }, "_id updatedAt").lean(),
      Category.find({ isActive: true }, "_id name updatedAt").lean(),
    ]);

    const urlEntries = [];

    // Static pages
    staticPages.forEach((page) => {
      urlEntries.push(buildUrlEntry(page));
    });

    // Category pages
    categories.forEach((cat) => {
      const lastmod = cat.updatedAt
        ? new Date(cat.updatedAt).toISOString().split("T")[0]
        : undefined;
      urlEntries.push(
        buildUrlEntry({
          loc: `${SITE_URL}/products?category=${cat._id}`,
          changefreq: "weekly",
          priority: "0.7",
          lastmod,
        })
      );
    });

    // Product pages
    products.forEach((product) => {
      const lastmod = product.updatedAt
        ? new Date(product.updatedAt).toISOString().split("T")[0]
        : undefined;
      urlEntries.push(
        buildUrlEntry({
          loc: `${SITE_URL}/products/${product._id}`,
          changefreq: "weekly",
          priority: "0.8",
          lastmod,
        })
      );
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
          http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
${urlEntries.join("\n")}
</urlset>`;

    res.setHeader("Content-Type", "application/xml");
    res.setHeader("Cache-Control", "public, max-age=3600"); // Cache for 1 hour
    return res.status(200).send(xml);
  } catch (error) {
    logger.error("Sitemap generation error:", error);
    return res.status(500).json({ error: "Failed to generate sitemap" });
  }
});

export default router;
