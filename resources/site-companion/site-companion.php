<?php
/**
 * Plugin Name:       Site Companion
 * Description:       Lets the website-gen desktop app manage this store over the REST API.
 * Version:           0.5.0
 * Requires at least: 6.8
 * Requires PHP:      8.1
 * License:           GPLv2 or later
 * Text Domain:       site-companion
 */

defined( 'ABSPATH' ) || exit;

const SITE_COMPANION_USER           = 'site-agent';
const SITE_COMPANION_APP_PASSWORD    = 'website-gen';
const SITE_COMPANION_ENROLLED_GEN    = 'site_companion_enrolled_generation';
const SITE_COMPANION_INFO            = 'site_companion_info';
const SITE_COMPANION_RULES           = 'site_companion_store_rules';
const SITE_COMPANION_METADATA        = 'site_companion_metadata';
// Site options the app may set through /site. The service user is a shop manager without manage_options,
// so this short allow-list is the only way it can change them.
const SITE_COMPANION_OPTIONS         = array( 'blogname', 'blogdescription', 'blog_public', 'show_on_front', 'page_on_front', 'wp_page_for_privacy_policy', 'woocommerce_coming_soon' );
const SITE_COMPANION_INFO_KEYS       = array( 'entity', 'email', 'phone', 'address', 'announcement' );
// Outgoing mail may only be routed through these providers, so the mail transport cannot be pointed at an arbitrary server.
const SITE_COMPANION_SMTP_HOSTS      = array( 'smtp.hostinger.com' );

/**
 * Only the app's own service user may change site options, pages or the mail transport through this plugin.
 * Other shop managers keep their normal WooCommerce rights but cannot, for example, redirect site mail
 * (which would let them intercept an administrator's password reset email).
 */
function site_companion_is_agent(): bool {
	return current_user_can( 'manage_woocommerce' ) && SITE_COMPANION_USER === wp_get_current_user()->user_login;
}

/**
 * Per-site enrollment config written by the desktop app at deploy time:
 * [ 'token_hash' => sha256 hex of the one-time token, 'expires' => unix time, 'generation' => int ].
 * Each deploy carries a higher generation, so the app can re-enroll (e.g. after losing the credentials),
 * while a used token can never be replayed. The template in resources/ has no enroll.php.
 */
function site_companion_enroll_config(): ?array {
	$file = __DIR__ . '/enroll.php';
	if ( ! is_readable( $file ) ) {
		return null;
	}
	$cfg = require $file;
	return is_array( $cfg ) && isset( $cfg['token_hash'], $cfg['expires'], $cfg['generation'] ) ? $cfg : null;
}

// Activation only creates the service user. Application passwords need HTTPS, and activation
// may run from WP-CLI, so the password is created later by the enroll request itself.
register_activation_hook( __FILE__, 'site_companion_activate' );
function site_companion_activate(): void {
	$user = get_user_by( 'login', SITE_COMPANION_USER );
	if ( ! $user ) {
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		$id   = wp_insert_user(
			array(
				'user_login'   => SITE_COMPANION_USER,
				'user_pass'    => wp_generate_password( 40, true, true ),
				'user_email'   => SITE_COMPANION_USER . '@' . $host,
				'display_name' => 'Site Agent',
				'role'         => get_role( 'shop_manager' ) ? 'shop_manager' : 'editor',
			)
		);
		if ( is_wp_error( $id ) ) {
			return;
		}
		$user = get_user_by( 'id', $id );
	}
	$user->add_cap( 'edit_theme_options' ); // global styles
	update_option( 'woocommerce_feature_order_attribution_enabled', 'no', false );
	site_companion_cleanup_defaults();
}

add_action( 'rest_api_init', 'site_companion_routes' );
function site_companion_routes(): void {
	register_rest_route(
		'site-agent/v1',
		'/enroll',
		array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true', // checked against the one-time token below
			'callback'            => 'site_companion_enroll',
		)
	);
	register_rest_route(
		'site-agent/v1',
		'/health',
		array(
			'methods'             => 'GET',
			'permission_callback' => fn() => current_user_can( 'manage_woocommerce' ) || current_user_can( 'edit_pages' ),
			'callback'            => 'site_companion_health',
		)
	);
	register_rest_route(
		'site-agent/v1',
		'/site',
		array(
			array(
				'methods'             => 'GET',
				'permission_callback' => 'site_companion_is_agent',
				'callback'            => 'site_companion_get_site',
			),
			array(
				'methods'             => 'POST',
				'permission_callback' => 'site_companion_is_agent',
				'callback'            => 'site_companion_set_site',
			),
		)
	);
	register_rest_route(
		'site-agent/v1',
		'/metadata',
		array(
			array(
				'methods'             => 'GET',
				'permission_callback' => 'site_companion_is_agent',
				'callback'            => 'site_companion_get_metadata',
			),
			array(
				'methods'             => 'POST',
				'permission_callback' => 'site_companion_is_agent',
				'callback'            => 'site_companion_set_metadata',
			),
		)
	);
	register_rest_route(
		'site-agent/v1',
		'/cleanup-defaults',
		array(
			'methods'             => 'POST',
			'permission_callback' => 'site_companion_is_agent',
			'callback'            => 'site_companion_cleanup_defaults_request',
		)
	);
}

// The page set as the privacy policy page needs manage_privacy_options (an admin capability) to edit,
// so the shop manager cannot even see it in REST edit lists. This endpoint publishes it at /privacy-policy/
// (reusing the draft WordPress created at install) and points the privacy policy setting at it.
add_action(
	'rest_api_init',
	static function (): void {
		register_rest_route(
			'site-agent/v1',
			'/privacy-page',
			array(
				array(
					'methods'             => 'GET',
					'permission_callback' => 'site_companion_is_agent',
					'callback'            => 'site_companion_get_privacy_page',
				),
				array(
					'methods'             => 'POST',
					'permission_callback' => 'site_companion_is_agent',
					'callback'            => 'site_companion_privacy_page',
				),
			)
		);
	}
);
// Raw title and content of the privacy policy page, so the app can snapshot it before an edit.
function site_companion_get_privacy_page() {
	$page = get_post( (int) get_option( 'wp_page_for_privacy_policy' ) );
	if ( ! $page || 'page' !== $page->post_type ) {
		return new WP_Error( 'site_companion_no_privacy_page', 'No privacy policy page is set.', array( 'status' => 404 ) );
	}
	return array(
		'id'      => $page->ID,
		'title'   => $page->post_title,
		'content' => $page->post_content,
	);
}
function site_companion_privacy_page( WP_REST_Request $request ) {
	$existing = get_page_by_path( 'privacy-policy', OBJECT, 'page' );
	$page     = array(
		'post_type'    => 'page',
		'post_status'  => 'publish',
		'post_name'    => 'privacy-policy',
		'post_title'   => sanitize_text_field( (string) $request->get_param( 'title' ) ),
		'post_content' => wp_kses_post( (string) $request->get_param( 'content' ) ),
	);
	$id = $existing ? wp_update_post( array( 'ID' => $existing->ID ) + $page, true ) : wp_insert_post( $page, true );
	if ( is_wp_error( $id ) ) {
		return $id;
	}
	update_option( 'wp_page_for_privacy_policy', (int) $id );
	return array( 'id' => (int) $id );
}

function site_companion_get_site(): array {
	$options = array();
	foreach ( SITE_COMPANION_OPTIONS as $name ) {
		$options[ $name ] = get_option( $name );
	}
	return array(
		'options' => $options,
		'info'    => (array) get_option( SITE_COMPANION_INFO, array() ),
		'rules'   => site_companion_rules(),
	);
}

/** Fixed operational promises copied from the app's shared rules at build time. */
function site_companion_rules(): array {
	$defaults = array(
		'free_shipping_over' => 49.0,
		'flat_rate'           => 4.99,
		'return_days'         => 30,
		'refund_days'         => array( 5, 7 ),
		'processing_days'     => array( 1, 3 ),
		'transit_days'        => array( 5, 10 ),
		'region'              => 'the contiguous United States (48 states and Washington, D.C.)',
	);
	$stored = get_option( SITE_COMPANION_RULES, array() );
	return is_array( $stored ) ? array_replace( $defaults, array_intersect_key( $stored, $defaults ) ) : $defaults;
}

/** Validate the deliberately small rules contract before storing any part of it. */
function site_companion_validate_rules( $value ) {
	$allowed = array( 'free_shipping_over', 'flat_rate', 'return_days', 'refund_days', 'processing_days', 'transit_days', 'region' );
	if ( ! is_array( $value ) || array_diff( array_keys( $value ), $allowed ) || array_diff( $allowed, array_keys( $value ) ) ) {
		return new WP_Error( 'site_companion_rules', 'Rules must contain exactly the supported fields.', array( 'status' => 400 ) );
	}
	if ( ! ( is_int( $value['free_shipping_over'] ) || is_float( $value['free_shipping_over'] ) ) || ! is_finite( (float) $value['free_shipping_over'] ) || $value['free_shipping_over'] <= 0 || $value['free_shipping_over'] > 100000 ) {
		return new WP_Error( 'site_companion_rules', 'free_shipping_over must be a finite positive number.', array( 'status' => 400 ) );
	}
	if ( ! ( is_int( $value['flat_rate'] ) || is_float( $value['flat_rate'] ) ) || ! is_finite( (float) $value['flat_rate'] ) || $value['flat_rate'] < 0 || $value['flat_rate'] > 10000 ) {
		return new WP_Error( 'site_companion_rules', 'flat_rate must be a finite non-negative number.', array( 'status' => 400 ) );
	}
	if ( ! is_int( $value['return_days'] ) || $value['return_days'] < 1 || $value['return_days'] > 90 ) {
		return new WP_Error( 'site_companion_rules', 'return_days must be an integer from 1 to 90.', array( 'status' => 400 ) );
	}
	if ( ! is_string( $value['region'] ) || '' === trim( $value['region'] ) || strlen( $value['region'] ) > 300 ) {
		return new WP_Error( 'site_companion_rules', 'region must be a non-empty string.', array( 'status' => 400 ) );
	}
	$pairs = array( 'refund_days', 'processing_days', 'transit_days' );
	foreach ( $pairs as $name ) {
		if ( ! is_array( $value[ $name ] ) || ! array_is_list( $value[ $name ] ) || 2 !== count( $value[ $name ] ) || ! is_int( $value[ $name ][0] ) || ! is_int( $value[ $name ][1] ) ) {
			return new WP_Error( 'site_companion_rules', "{$name} must contain two day counts.", array( 'status' => 400 ) );
		}
		if ( $value[ $name ][0] < 1 || $value[ $name ][1] < $value[ $name ][0] || $value[ $name ][1] > 90 ) {
			return new WP_Error( 'site_companion_rules', "{$name} is outside the supported range.", array( 'status' => 400 ) );
		}
	}
	$value['free_shipping_over'] = (float) $value['free_shipping_over'];
	$value['flat_rate']           = (float) $value['flat_rate'];
	$value['region']              = sanitize_text_field( (string) $value['region'] );
	return $value;
}

function site_companion_set_site( WP_REST_Request $request ) {
	$options = (array) $request->get_param( 'options' );
	foreach ( array_keys( $options ) as $name ) {
		if ( ! in_array( $name, SITE_COMPANION_OPTIONS, true ) ) {
			return new WP_Error( 'site_companion_option', "Option {$name} cannot be changed here.", array( 'status' => 400 ) );
		}
	}
	$rules = $request->get_param( 'rules' );
	if ( null !== $rules ) {
		$rules = site_companion_validate_rules( $rules );
		if ( is_wp_error( $rules ) ) {
			return $rules;
		}
	}
	foreach ( $options as $name => $value ) {
		if ( in_array( $name, array( 'blog_public', 'page_on_front', 'wp_page_for_privacy_policy' ), true ) ) {
			$value = absint( $value );
		} elseif ( 'woocommerce_coming_soon' === $name ) {
			$value = 'yes' === $value ? 'yes' : 'no';
		} elseif ( 'show_on_front' === $name ) {
			$value = 'page' === $value ? 'page' : 'posts';
		} else {
			$value = sanitize_text_field( (string) $value );
		}
		update_option( $name, $value );
	}
	$info = $request->get_param( 'info' );
	if ( is_array( $info ) ) {
		$info = array_intersect_key( $info, array_flip( SITE_COMPANION_INFO_KEYS ) );
		update_option( SITE_COMPANION_INFO, array_map( fn( $v ) => sanitize_text_field( (string) $v ), $info ), false );
	}
	if ( null !== $rules ) {
		update_option( SITE_COMPANION_RULES, $rules, false );
	}
	return site_companion_get_site();
}

// ---- Transactional mail over SMTP --------------------------------------------------------------
// WooCommerce and WordPress mail goes out through the store's own mailbox (e.g. support@ on Hostinger Email)
// instead of the web server's sendmail, which mailbox providers often junk. The SMTP password is stored
// encrypted with a key derived from this site's auth salt, so a database dump alone does not reveal it.
const SITE_COMPANION_SMTP = 'site_companion_smtp';

function site_companion_smtp_key(): string {
	return hash( 'sha256', wp_salt( 'auth' ) . '|site-companion-smtp', true );
}
function site_companion_seal( string $plain ): string {
	$nonce = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
	return base64_encode( $nonce . sodium_crypto_secretbox( $plain, $nonce, site_companion_smtp_key() ) );
}
function site_companion_unseal( string $sealed ): ?string {
	$raw = base64_decode( $sealed, true );
	if ( false === $raw || strlen( $raw ) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
		return null;
	}
	$plain = sodium_crypto_secretbox_open( substr( $raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ), substr( $raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ), site_companion_smtp_key() );
	return false === $plain ? null : $plain;
}

/** Stored SMTP settings with the password decrypted, or null when SMTP is off. */
function site_companion_smtp_config(): ?array {
	$cfg = get_option( SITE_COMPANION_SMTP );
	if ( ! is_array( $cfg ) || empty( $cfg['host'] ) || empty( $cfg['password'] ) ) {
		return null;
	}
	$password = site_companion_unseal( (string) $cfg['password'] );
	return null === $password ? null : array( 'password' => $password ) + $cfg;
}

add_action( 'phpmailer_init', 'site_companion_phpmailer' );
function site_companion_phpmailer( $phpmailer ): void {
	$cfg = site_companion_smtp_config();
	if ( ! $cfg ) {
		return;
	}
	$phpmailer->isSMTP();
	$phpmailer->Host       = $cfg['host'];
	$phpmailer->Port       = (int) $cfg['port'];
	$phpmailer->SMTPSecure = $cfg['secure'];
	$phpmailer->SMTPAuth   = true;
	$phpmailer->Username   = $cfg['username'];
	$phpmailer->Password   = $cfg['password'];
	$phpmailer->Timeout    = 20;
	// The SMTP server only accepts mail sent as the mailbox it authenticated.
	$phpmailer->setFrom( $cfg['from_email'], $cfg['from_name'] ? $cfg['from_name'] : $phpmailer->FromName, false );
	$phpmailer->Sender = $cfg['from_email'];
}

add_action(
	'rest_api_init',
	static function (): void {
		$can = 'site_companion_is_agent';
		register_rest_route(
			'site-agent/v1',
			'/smtp',
			array(
				array( 'methods' => 'GET', 'permission_callback' => $can, 'callback' => 'site_companion_get_smtp' ),
				array( 'methods' => 'POST', 'permission_callback' => $can, 'callback' => 'site_companion_set_smtp' ),
			)
		);
		register_rest_route( 'site-agent/v1', '/smtp/test', array( 'methods' => 'POST', 'permission_callback' => $can, 'callback' => 'site_companion_test_smtp' ) );
	}
);

function site_companion_get_smtp(): array {
	$cfg = get_option( SITE_COMPANION_SMTP );
	$on  = null !== site_companion_smtp_config();
	return array(
		'enabled'    => $on,
		'host'       => $on ? $cfg['host'] : null,
		'port'       => $on ? (int) $cfg['port'] : null,
		'secure'     => $on ? $cfg['secure'] : null,
		'username'   => $on ? $cfg['username'] : null,
		'from_email' => $on ? $cfg['from_email'] : null,
		'from_name'  => $on ? $cfg['from_name'] : null,
	);
}

function site_companion_set_smtp( WP_REST_Request $request ) {
	if ( false === $request->get_param( 'enabled' ) ) {
		delete_option( SITE_COMPANION_SMTP );
		return site_companion_get_smtp();
	}
	$host     = sanitize_text_field( (string) $request->get_param( 'host' ) );
	$port     = (int) $request->get_param( 'port' );
	$secure   = (string) $request->get_param( 'secure' );
	$username = sanitize_email( (string) $request->get_param( 'username' ) );
	$from     = sanitize_email( (string) $request->get_param( 'from_email' ) );
	$password = (string) $request->get_param( 'password' );
	if ( ! in_array( $host, SITE_COMPANION_SMTP_HOSTS, true ) || ! in_array( $port, array( 465, 587 ), true ) || ! in_array( $secure, array( 'ssl', 'tls' ), true ) || ! is_email( $username ) || ! is_email( $from ) || '' === $password ) {
		return new WP_Error( 'site_companion_smtp', 'host (' . implode( ', ', SITE_COMPANION_SMTP_HOSTS ) . '), port (465/587), secure (ssl/tls), username, from_email and password are required.', array( 'status' => 400 ) );
	}
	update_option(
		SITE_COMPANION_SMTP,
		array(
			'host'       => $host,
			'port'       => $port,
			'secure'     => $secure,
			'username'   => $username,
			'password'   => site_companion_seal( $password ),
			'from_email' => $from,
			'from_name'  => sanitize_text_field( (string) $request->get_param( 'from_name' ) ),
		),
		false
	);
	return site_companion_get_smtp();
}

// Sends one plain-text email through wp_mail (the same path WooCommerce uses) and reports the SMTP error if any.
function site_companion_test_smtp( WP_REST_Request $request ) {
	$to = sanitize_email( (string) $request->get_param( 'to' ) );
	if ( ! is_email( $to ) ) {
		return new WP_Error( 'site_companion_smtp_test', 'A valid "to" address is required.', array( 'status' => 400 ) );
	}
	$error  = null;
	$listen = function ( WP_Error $e ) use ( &$error ) {
		$error = $e->get_error_message();
	};
	add_action( 'wp_mail_failed', $listen );
	$subject = sanitize_text_field( (string) $request->get_param( 'subject' ) );
	$sent    = wp_mail( $to, '' !== $subject ? $subject : 'Test email from ' . get_bloginfo( 'name' ), "This is a test email from your store's mail settings.\n\nIf you received it, order emails will be delivered the same way.\n" );
	remove_action( 'wp_mail_failed', $listen );
	return array(
		'ok'    => (bool) $sent && null === $error,
		'smtp'  => null !== site_companion_smtp_config(),
		'error' => $error,
	);
}

// [site_info key="email|phone|address|entity|announcement|copyright"]: per-site details used by the shared theme's header and footer.
add_shortcode( 'site_info', 'site_companion_info_shortcode' );
function site_companion_info_shortcode( $atts ): string {
	$key  = (string) shortcode_atts( array( 'key' => '' ), $atts )['key'];
	$info = (array) get_option( SITE_COMPANION_INFO, array() );
	$text = (string) ( $info[ $key ] ?? '' );
	switch ( $key ) {
		case 'copyright':
			return esc_html( '© ' . gmdate( 'Y' ) . ' ' . ( $info['entity'] ?? get_bloginfo( 'name' ) ) . '. All rights reserved.' );
		case 'email':
			return '' === $text ? '' : '<a href="mailto:' . esc_attr( $text ) . '">' . esc_html( $text ) . '</a>';
		case 'phone':
			return '' === $text ? '' : '<a href="tel:' . esc_attr( preg_replace( '/[^\d+]/', '', $text ) ) . '">' . esc_html( $text ) . '</a>';
		default:
			return esc_html( $text );
	}
}

// 商品页与政策页共用同一份由应用写入的经营规则，主题不再维护第二套承诺。
add_shortcode( 'site_shipping_returns', 'site_companion_shipping_returns_shortcode' );
function site_companion_shipping_returns_shortcode(): string {
	$rules   = site_companion_rules();
	$range   = static fn( array $days ): string => $days[0] === $days[1] ? (string) $days[0] : $days[0] . '–' . $days[1];
	$money   = static fn( float $amount ): string => floor( $amount ) === $amount ? number_format_i18n( $amount, 0 ) : number_format_i18n( $amount, 2 );
	$free    = $money( (float) $rules['free_shipping_over'] );
	$flat    = $money( (float) $rules['flat_rate'] );
	$content = sprintf(
		'Orders are processed in %1$s business days and usually arrive %2$s business days after shipment. Shipping is free when the product subtotal after discounts is $%3$s or more, excluding taxes and shipping charges; otherwise, standard shipping is $%4$s. We ship only to %5$s. Request a return within %6$d days of delivery and wait for approval and return instructions before shipping it back. Approved refunds are sent to the original payment method within %7$s business days after the return is received.',
		esc_html( $range( $rules['processing_days'] ) ),
		esc_html( $range( $rules['transit_days'] ) ),
		esc_html( $free ),
		esc_html( $flat ),
		esc_html( $rules['region'] ),
		(int) $rules['return_days'],
		esc_html( $range( $rules['refund_days'] ) )
	);
	return '<p>' . $content . '</p>';
}

/** Map the REST target contract to a stable metadata option key. */
function site_companion_metadata_key( string $type, int $id ) {
	if ( ! in_array( $type, array( 'home', 'shop', 'page', 'product', 'product_cat' ), true ) ) {
		return new WP_Error( 'site_companion_metadata', 'Unsupported metadata target_type.', array( 'status' => 400 ) );
	}
	if ( in_array( $type, array( 'home', 'shop' ), true ) ) {
		if ( 0 !== $id ) {
			return new WP_Error( 'site_companion_metadata', 'target_id must be 0 for home and shop.', array( 'status' => 400 ) );
		}
		return $type;
	}
	if ( $id < 1 ) {
		return new WP_Error( 'site_companion_metadata', 'target_id is required for this target_type.', array( 'status' => 400 ) );
	}
	if ( in_array( $type, array( 'page', 'product' ), true ) ) {
		$post = get_post( $id );
		if ( ! $post || $type !== $post->post_type ) {
			return new WP_Error( 'site_companion_metadata', 'The metadata post target does not exist.', array( 'status' => 404 ) );
		}
	} elseif ( 'product_cat' === $type ) {
		$term = get_term( $id, 'product_cat' );
		if ( ! $term || is_wp_error( $term ) ) {
			return new WP_Error( 'site_companion_metadata', 'The metadata category target does not exist.', array( 'status' => 404 ) );
		}
	}
	return $type . ':' . $id;
}

function site_companion_get_metadata( WP_REST_Request $request ) {
	$items = (array) get_option( SITE_COMPANION_METADATA, array() );
	$type  = sanitize_key( (string) $request->get_param( 'target_type' ) );
	if ( '' === $type ) {
		return array( 'items' => $items );
	}
	$key = site_companion_metadata_key( $type, absint( $request->get_param( 'target_id' ) ) );
	if ( is_wp_error( $key ) ) {
		return $key;
	}
	return isset( $items[ $key ] )
		? array( 'exists' => true ) + $items[ $key ]
		: array(
			'target_type'    => $type,
			'target_id'      => absint( $request->get_param( 'target_id' ) ),
			'description'    => '',
			'og_description' => '',
			'exists'         => false,
		);
}

function site_companion_set_metadata( WP_REST_Request $request ) {
	$json    = $request->get_json_params();
	$allowed = array( 'target_type', 'target_id', 'description', 'og_description' );
	if ( ! is_array( $json ) || array_diff( array_keys( $json ), $allowed ) || array_diff( $allowed, array_keys( $json ) ) ) {
		return new WP_Error( 'site_companion_metadata', 'Metadata must contain exactly the supported fields.', array( 'status' => 400 ) );
	}
	$type = sanitize_key( (string) $request->get_param( 'target_type' ) );
	$id   = absint( $request->get_param( 'target_id' ) );
	$key  = site_companion_metadata_key( $type, $id );
	if ( is_wp_error( $key ) ) {
		return $key;
	}
	$description = sanitize_textarea_field( (string) $request->get_param( 'description' ) );
	$og          = sanitize_textarea_field( (string) $request->get_param( 'og_description' ) );
	$length      = static fn( string $text ): int => function_exists( 'mb_strlen' ) ? mb_strlen( $text ) : strlen( $text );
	if ( ( '' === $description ) !== ( '' === $og ) || $length( $description ) > 320 || $length( $og ) > 320 ) {
		return new WP_Error( 'site_companion_metadata', 'Descriptions must both be empty (delete) or both contain at most 320 characters.', array( 'status' => 400 ) );
	}
	$items = (array) get_option( SITE_COMPANION_METADATA, array() );
	if ( '' === $description ) {
		unset( $items[ $key ] );
		update_option( SITE_COMPANION_METADATA, $items, false );
		return array(
			'target_type'    => $type,
			'target_id'      => $id,
			'description'    => '',
			'og_description' => '',
			'exists'         => false,
		);
	}
	$items[ $key ] = array(
		'target_type'   => $type,
		'target_id'     => $id,
		'description'   => $description,
		'og_description' => $og,
	);
	update_option( SITE_COMPANION_METADATA, $items, false );
	return array( 'exists' => true ) + $items[ $key ];
}

function site_companion_current_metadata(): ?array {
	$key = null;
	if ( is_front_page() ) {
		$key = 'home';
	} elseif ( function_exists( 'is_shop' ) && is_shop() ) {
		$key = 'shop';
	} elseif ( function_exists( 'is_product' ) && is_product() ) {
		$key = 'product:' . get_queried_object_id();
	} elseif ( function_exists( 'is_product_category' ) && is_product_category() ) {
		$key = 'product_cat:' . get_queried_object_id();
	} elseif ( is_page() ) {
		$key = 'page:' . get_queried_object_id();
	}
	$items = (array) get_option( SITE_COMPANION_METADATA, array() );
	return $key && isset( $items[ $key ] ) && is_array( $items[ $key ] ) ? $items[ $key ] : null;
}

add_action(
	'wp_head',
	static function (): void {
		$metadata = site_companion_current_metadata();
		if ( ! $metadata ) {
			return;
		}
		echo '<meta name="description" content="' . esc_attr( $metadata['description'] ) . '">' . "\n";
		echo '<meta property="og:description" content="' . esc_attr( $metadata['og_description'] ) . '">' . "\n";
	},
	2
);

/** Remove only WordPress' known installer samples; repeated runs are harmless. */
function site_companion_cleanup_defaults(): array {
	$deleted = array();
	$hello   = get_page_by_path( 'hello-world', OBJECT, 'post' );
	if ( $hello && 'Hello world!' === $hello->post_title && false !== stripos( $hello->post_content, 'Welcome to WordPress' ) ) {
		foreach ( get_comments( array( 'post_id' => $hello->ID ) ) as $comment ) {
			wp_delete_comment( $comment->comment_ID, true );
		}
		wp_delete_post( $hello->ID, true );
		$deleted[] = 'hello-world';
	}
	$sample = get_page_by_path( 'sample-page', OBJECT, 'page' );
	if ( $sample && 'Sample Page' === $sample->post_title && false !== stripos( $sample->post_content, 'This is an example page' ) ) {
		wp_delete_post( $sample->ID, true );
		$deleted[] = 'sample-page';
	}
	$uncategorized = get_term_by( 'slug', 'uncategorized', 'category' );
	if ( $uncategorized && ! is_wp_error( $uncategorized ) ) {
		wp_update_term( $uncategorized->term_id, 'category', array( 'name' => 'General', 'slug' => 'general' ) );
	}
	return array( 'deleted' => $deleted, 'default_category' => $uncategorized ? 'general' : null );
}

function site_companion_cleanup_defaults_request( WP_REST_Request $request ) {
	$json = $request->get_json_params();
	if ( is_array( $json ) && array() !== $json ) {
		return new WP_Error( 'site_companion_cleanup', 'This endpoint accepts no fields.', array( 'status' => 400 ) );
	}
	return site_companion_cleanup_defaults();
}

// WooCommerce attribution is not enabled by this product, so its sourcebuster cookies must stay off.
add_filter( 'woocommerce_feature_order_attribution_enabled', '__return_false' );
add_action(
	'init',
	static function (): void {
		if ( 'no' !== get_option( 'woocommerce_feature_order_attribution_enabled' ) ) {
			update_option( 'woocommerce_feature_order_attribution_enabled', 'no', false );
		}
	},
	1
);

// 作者归档不属于商店内容；阻止索引并从 WordPress XML sitemap 中移除。
add_filter(
	'wp_robots',
	static function ( array $robots ): array {
		if ( is_author() ) {
			$robots['noindex'] = true;
			unset( $robots['index'] );
		}
		return $robots;
	}
);
add_filter(
	'wp_sitemaps_add_provider',
	static function ( $provider, string $name ) {
		return 'users' === $name ? false : $provider;
	},
	10,
	2
);

/** Hide paid methods once a free-shipping rate is actually available for this package. */
function site_companion_hide_paid_rates_when_free( array $rates ): array {
	$has_free = false;
	foreach ( $rates as $rate ) {
		$method = is_object( $rate ) && method_exists( $rate, 'get_method_id' )
			? $rate->get_method_id()
			: ( is_array( $rate ) ? ( $rate['method_id'] ?? '' ) : ( $rate->method_id ?? '' ) );
		if ( 'free_shipping' === $method ) {
			$has_free = true;
			break;
		}
	}
	if ( ! $has_free ) {
		return $rates;
	}
	return array_filter(
		$rates,
		static function ( $rate ): bool {
			$method = is_object( $rate ) && method_exists( $rate, 'get_method_id' )
				? $rate->get_method_id()
				: ( is_array( $rate ) ? ( $rate['method_id'] ?? '' ) : ( $rate->method_id ?? '' ) );
			$cost = is_object( $rate ) && method_exists( $rate, 'get_cost' )
				? (float) $rate->get_cost()
				: (float) ( is_array( $rate ) ? ( $rate['cost'] ?? 0 ) : ( $rate->cost ?? 0 ) );
			return 'free_shipping' === $method || $cost <= 0;
		}
	);
}
add_filter( 'woocommerce_package_rates', 'site_companion_hide_paid_rates_when_free', 100 );

function site_companion_enroll( WP_REST_Request $request ) {
	$cfg   = site_companion_enroll_config();
	$token = (string) $request->get_header( 'x-site-agent-enroll' );
	$valid = $cfg
		&& (int) $cfg['generation'] > (int) get_option( SITE_COMPANION_ENROLLED_GEN, 0 )
		&& $cfg['expires'] >= time()
		&& '' !== $token
		&& hash_equals( (string) $cfg['token_hash'], hash( 'sha256', $token ) );
	if ( ! $valid ) {
		return new WP_Error( 'site_companion_forbidden', 'Enrollment is not available.', array( 'status' => 403 ) );
	}

	$user = get_user_by( 'login', SITE_COMPANION_USER );
	if ( ! $user ) {
		return new WP_Error( 'site_companion_no_user', 'Plugin has not been activated.', array( 'status' => 409 ) );
	}
	if ( ! wp_is_application_passwords_available_for_user( $user ) ) {
		return new WP_Error( 'site_companion_no_app_passwords', 'Application passwords are unavailable (HTTPS required).', array( 'status' => 409 ) );
	}

	// Re-enrolling rotates the credential: earlier passwords issued to the app stop working.
	foreach ( WP_Application_Passwords::get_user_application_passwords( $user->ID ) as $item ) {
		if ( SITE_COMPANION_APP_PASSWORD === $item['name'] ) {
			WP_Application_Passwords::delete_application_password( $user->ID, $item['uuid'] );
		}
	}
	$created = WP_Application_Passwords::create_new_application_password( $user->ID, array( 'name' => SITE_COMPANION_APP_PASSWORD ) );
	if ( is_wp_error( $created ) ) {
		return $created;
	}
	update_option( SITE_COMPANION_ENROLLED_GEN, (int) $cfg['generation'], false ); // this token (and older ones) can never be used again

	return array(
		'username' => SITE_COMPANION_USER,
		'password' => $created[0],
		'site'     => home_url(),
	);
}

function site_companion_health(): array {
	$theme = wp_get_theme();
	return array(
		'wp'          => get_bloginfo( 'version' ),
		'php'         => PHP_VERSION,
		'woocommerce' => defined( 'WC_VERSION' ) ? WC_VERSION : null,
		'theme'       => $theme->get_stylesheet() . ' ' . $theme->get( 'Version' ),
		'user'        => wp_get_current_user()->user_login,
	);
}
