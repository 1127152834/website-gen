import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const companion = read("resources/site-companion/site-companion.php");
const theme = read("resources/theme/obel/functions.php");
const stylesheet = read("resources/theme/obel/style.css");
const themeReadme = read("resources/theme/obel/readme.txt");
const header = read("resources/theme/obel/parts/header.html");
const product = read("resources/theme/obel/templates/single-product.html");
const shop = read("resources/theme/obel/templates/archive-product.html");
const search = read("resources/theme/obel/templates/search.html");

test("phase 3 resources ship the companion 0.5.1 contract behind the agent permission", () => {
  assert.match(companion, /Version:\s+0\.5\.1/);
  for (const route of ["/metadata", "/cleanup-defaults"]) {
    const at = companion.indexOf(`'${route}'`);
    assert.notEqual(at, -1, `${route} route exists`);
    assert.match(companion.slice(at, at + 900), /'permission_callback'\s*=>\s*'site_companion_is_agent'/);
  }
  assert.match(companion, /SITE_COMPANION_RULES/);
  assert.match(companion, /processing_days.*transit_days/s);
  assert.match(companion, /get_json_params\(\).*Metadata must contain exactly the supported fields/s);
  assert.match(companion, /site_companion_cleanup_defaults_request/);
  assert.match(companion, /is_int\( \$value\['return_days'\] \)/);
  assert.match(companion, /array_is_list\( \$value\[ \$name \] \)/);
  assert.doesNotMatch(companion.slice(companion.indexOf("function site_companion_validate_rules"), companion.indexOf("function site_companion_set_site")), /absint/);
});

test("the site endpoint strictly validates logo and icon image attachment IDs before writes", () => {
  assert.match(companion, /SITE_COMPANION_OPTIONS[\s\S]*'site_icon'/);
  assert.match(companion, /SITE_COMPANION_THEME_MODS[\s\S]*'custom_logo'/);
  assert.match(companion, /get_theme_mod\( \$name, 0 \)/);
  assert.match(companion, /! is_int\( \$value \) \|\| \$value < 1/);
  assert.match(companion, /'attachment' !== get_post_type\( \$value \)/);
  assert.match(companion, /! wp_attachment_is_image\( \$value \)/);
  assert.match(companion, /set_theme_mod\( 'custom_logo', \$value \)/);

  const setter = companion.slice(
    companion.indexOf("function site_companion_set_site"),
    companion.indexOf("// ---- Transactional mail", companion.indexOf("function site_companion_set_site")),
  );
  assert.match(setter, /\$allowed = array_merge\( SITE_COMPANION_OPTIONS, SITE_COMPANION_THEME_MODS \)/);
  assert.match(setter, /foreach \( array\( 'site_icon', 'custom_logo' \) as \$name \)[\s\S]*site_companion_validate_image_attachment/);
  assert.match(setter, /'site_icon' === \$name[\s\S]*update_option\( \$name, \$value \)/);
  const mediaValidation = setter.indexOf("site_companion_validate_image_attachment");
  const firstOptionWrite = setter.indexOf("update_option(");
  assert.ok(mediaValidation >= 0 && firstOptionWrite > mediaValidation, "image settings are validated before option writes");
  assert.ok(setter.indexOf("set_theme_mod(") > mediaValidation, "image settings are validated before theme-mod writes");
});

test("Obel 1.2.2 renders the wordmark on desktop and mobile with the title as its no-logo fallback", () => {
  assert.match(stylesheet, /Version:\s+1\.2\.2/);
  assert.match(themeReadme, /Stable tag:\s+1\.2\.2/);
  assert.match(header, /wp:site-logo[^\n]*"width":240[^\n]*obel-header__logo/);
  assert.match(header, /wp:site-title/);
  assert.match(stylesheet, /body\.wp-custom-logo[\s\S]*\.obel-header__brand[\s\S]*\.wp-block-site-title[\s\S]*display:\s*none/);
  assert.match(stylesheet, /@media \(max-width:\s*781px\)[\s\S]*\.obel-header__logo/);
});

test("audit 01 and 05: product promises come from the shared-rule shortcode without Express or invented materials", () => {
  assert.match(product, /\[site_shipping_returns\]/);
  assert.doesNotMatch(product, /Express|\$50|Materials and care|responsibly sourced|finished by hand/i);
  assert.match(companion, /function site_companion_shipping_returns_shortcode/);
  assert.match(companion, /free_shipping_over/);
  const shippingReturns = companion.slice(companion.indexOf("function site_companion_shipping_returns_shortcode"), companion.indexOf("function site_companion_metadata_key"));
  assert.match(shippingReturns, /product subtotal after discounts is \$%3\$s or more, excluding taxes and shipping charges/);
  assert.match(shippingReturns, /Request a return within %6\$d days of delivery and wait for approval and return instructions before shipping it back/);
  assert.doesNotMatch(shippingReturns, /Express/i);
});

test("audit 02: the product template renders WooCommerce's real gallery", () => {
  assert.match(product, /wp:woocommerce\/product-image-gallery/);
  assert.doesNotMatch(product, /wp:post-featured-image/);
  for (const feature of ["zoom", "lightbox", "slider"]) assert.match(theme, new RegExp(`wc-product-gallery-${feature}`));
});

test("audit 06: order attribution is disabled in both persisted configuration and runtime", () => {
  assert.match(companion, /update_option\( 'woocommerce_feature_order_attribution_enabled', 'no'/);
  assert.match(companion, /add_filter\( 'woocommerce_feature_order_attribution_enabled', '__return_false' \)/);
});

test("audit 09: payment marks are derived only from enabled available gateways", () => {
  const payments = theme.slice(theme.indexOf("// === BEGIN payment-icons ==="), theme.indexOf("// === END payment-icons ==="));
  assert.match(payments, /get_available_payment_gateways/);
  assert.match(payments, /'yes' !== \$gateway->enabled/);
  assert.doesNotMatch(payments, /name: 'Visa'|name: 'Mastercard'|name: 'Apple Pay'|name: 'Google Pay'/);
  assert.match(payments, /if \( array\(\) === \$methods \)/);
});

test("audit 10: result counts use the authoritative archive count instead of a premature zero", () => {
  assert.match(shop, /woocommerce\/product-results-count/);
  assert.match(theme, /\$GLOBALS\['wp_query'\]->found_posts/);
  assert.match(theme, /_n\( '%d item', '%d items'/);
  assert.match(theme, /Showing %1\$d–%2\$d of %3\$d items/);
  assert.match(theme, /wc_get_loop_prop\( 'current_page'/);
});

test("audit 11: every public search is product-only and renders image, title, price, and pagination", () => {
  assert.match(theme, /'pre_get_posts'/);
  assert.match(theme, /\$query->set\( 'post_type', 'product' \)/);
  assert.match(search, /woocommerce\/product-image/);
  assert.match(search, /woocommerce\/product-price/);
  assert.match(search, /query-pagination/);
  assert.doesNotMatch(search, /post-date|Continue reading/);
});

test("audit 13: installer samples are removed idempotently and author archives are excluded", () => {
  assert.match(companion, /function site_companion_cleanup_defaults/);
  assert.match(companion, /get_page_by_path\( 'hello-world'.*wp_delete_post/s);
  assert.match(companion, /get_page_by_path\( 'sample-page'.*wp_delete_post/s);
  assert.match(companion, /wp_delete_comment/);
  assert.match(companion, /wp_update_term\( \$uncategorized->term_id.*'General'/s);
  assert.match(companion, /'wp_robots'/);
  assert.match(companion, /'wp_sitemaps_add_provider'/);
  assert.match(companion, /'users' === \$name \? false/);
});

test("audit 15: strict metadata writes feed description and OG description in head", () => {
  assert.match(companion, /array\( 'home', 'shop', 'page', 'product', 'product_cat' \)/);
  assert.match(companion, /function site_companion_set_metadata/);
  assert.match(companion, /<meta name="description"/);
  assert.match(companion, /<meta property="og:description"/);
  assert.match(companion, /esc_attr\( \$metadata\['description'\] \)/);
  assert.match(companion, /'exists'\s*=>\s*false/);
  assert.match(companion, /unset\( \$items\[ \$key \] \)/);
  assert.match(companion, /\( '' === \$description \) !== \( '' === \$og \)/);
});

test("audit 16: paid rates are removed only after free shipping is actually available", () => {
  assert.match(companion, /add_filter\( 'woocommerce_package_rates', 'site_companion_hide_paid_rates_when_free', 100 \)/);
  const start = companion.indexOf("function site_companion_hide_paid_rates_when_free");
  const filter = companion.slice(start, companion.indexOf("function site_companion_enroll", start));
  assert.match(filter, /'free_shipping' === \$method/);
  assert.match(filter, /return 'free_shipping' === \$method \|\| \$cost <= 0/);
  assert.match(filter, /if \( ! \$has_free \) \{\s*return \$rates;/s);
});

test("audit 14: AI homepage stays product-first and responsive without breaking footer email addresses", () => {
  assert.match(stylesheet, /\.wg-mobile-first-product \.wp-block-image img\s*\{[^}]*object-fit:\s*contain/s);
  assert.match(stylesheet, /@media \(max-width:\s*781px\)[\s\S]*?\.wg-mobile-first-product \.wp-block-image img\s*\{[^}]*max-height:\s*min\(320px,\s*42vh\)/);
  assert.match(stylesheet, /\.wg-home-intro[\s\S]*?max-width:\s*720px/);
  assert.match(stylesheet, /\.wg-category-grid,[\s\S]*?\.wg-product-grid[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(stylesheet, /@media \(min-width:\s*782px\)[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(stylesheet, /\.wg-product-grid \.wp-block-image img\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*3[^}]*object-fit:\s*cover/s);
  assert.match(stylesheet, /footer a\[href\^="mailto:"\][\s\S]*?overflow-wrap:\s*anywhere/);
});


// 实测 2026-10-15：块主题不会自动在前台加载 style.css，Logo 尺寸、隐藏店名等规则在线上都没生效
test("the Obel stylesheet is enqueued on the front end and the footer shows a readable wordmark", () => {
  assert.match(theme, /wp_enqueue_scripts[\s\S]{0,300}wp_enqueue_style\(\s*'obel-style',\s*get_stylesheet_uri\(\)/);
  const footer = read("resources/theme/obel/parts/footer.html");
  assert.doesNotMatch(footer, /wp:site-logo \{"width":36\}/);
  assert.match(stylesheet, /:has\(\.wp-block-site-logo img\)[^{]*\.wp-block-site-title/);
});
